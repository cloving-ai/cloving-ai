import type { Database, Logger } from "solid-objects";
import { eligibleIntents, type EffectIntent } from "../../authority/reducer.ts";
import {
  loadProjections,
  type ProjectionSnapshot,
} from "../../storage/decision-snapshots.ts";
import type { DomainChange } from "../../storage/domain-changes.ts";
import type { SqlConnection } from "../../storage/domain-rows.ts";
import {
  messageOutcomes,
  recordedTimes,
  runTimes,
  storedWorkflows,
  submittedWorkflows,
  type MessageOutcome,
} from "../../storage/projection-lookups.ts";
import {
  changedProjection,
  followingSequence,
  projectedChange,
  type ProjectedChange,
} from "../../storage/projection-changes.ts";
import {
  currentState,
  intentKind,
  type StoredState,
} from "../authority-restore.ts";
import type { Sequences } from "./authority-queries.ts";

export interface OperationRecord {
  readonly operationId: string;
  readonly kind: EffectIntent["kind"];
  readonly runId: string;
  readonly createdSequence: number;
  readonly releasedSequence: number | null;
  readonly deliveries: readonly {
    readonly effectId: string;
    readonly outcome: string | null;
    readonly receipt: string | null;
    readonly purpose: string;
    readonly epoch: number | null;
  }[];
}

export interface Projection {
  readonly snapshot: ProjectionSnapshot;
  readonly state: () => StoredState;
  readonly eligible: () => readonly EffectIntent[];
  readonly operations: () => readonly OperationRecord[];
  readonly sequences: () => Sequences;
  readonly workflowIds: (
    runIds?: readonly string[],
  ) => Readonly<Record<string, string>>;
}

type Source = Pick<Database, "connection">;

export interface ProjectionMemory {
  readonly record: (change: RecordedChange) => void;
  readonly load: (database: Source) => Promise<void>;
  readonly read: (database: Source) => Promise<Projection>;
}

export interface RecordedChange {
  readonly messageId: string;
  readonly change: DomainChange;
}

interface Held {
  readonly snapshot: ProjectionSnapshot;
  readonly times: ReadonlyMap<string, string>;
  readonly workflows: ReadonlyMap<string, string | null>;
  readonly projection: Projection;
}

interface Memory {
  held: Held | undefined;
  stale: string | null;
  readonly recorded: Map<string, ProjectedChange>;
  readonly logger: Logger;
}

const pendingLimit = 1_000;

export function projectionMemory(options: {
  readonly logger: Logger;
}): ProjectionMemory {
  const memory: Memory = {
    held: undefined,
    stale: null,
    recorded: new Map(),
    logger: options.logger,
  };
  return {
    record: ({ messageId, change }) => {
      memory.recorded.delete(messageId);
      memory.recorded.set(messageId, projectedChange(change));
      if (memory.recorded.size <= pendingLimit) return;
      memory.recorded.clear();
      memory.held = undefined;
    },
    load: (database) =>
      database.connection(async (connection) => {
        memory.recorded.clear();
        memory.held = await rebuilt(connection);
      }),
    read: (database) =>
      database.connection(async (connection) => {
        const held = await advanced(memory, connection);
        return held.projection;
      }),
  };
}

async function advanced(
  memory: Memory,
  connection: SqlConnection,
): Promise<Held> {
  const recorded = [...memory.recorded];
  memory.recorded.clear();
  try {
    memory.held = await updated(memory, { recorded, connection });
  } catch (error) {
    memory.held = undefined;
    memory.stale = `update failed: ${String(Reflect.get(Object(error), "message"))}`;
    throw error;
  }
  return memory.held;
}

async function updated(
  memory: Memory,
  update: {
    readonly recorded: readonly (readonly [string, ProjectedChange])[];
    readonly connection: SqlConnection;
  },
): Promise<Held> {
  const { recorded, connection } = update;
  if (memory.held === undefined) return rebuiltAfter(memory, connection);
  if (recorded.length === 0) return memory.held;
  const outcomes = await messageOutcomes(
    connection,
    recorded.map(([messageId]) => messageId),
  );
  const committed: ProjectedChange[] = [];
  let sequence = memory.held.snapshot.sequence;
  for (const [messageId, change] of recorded) {
    const outcome = outcomes.get(messageId) ?? "missing";
    if (outcome === "rolled-back") continue;
    const reason = mismatch({ messageId, change, outcome, sequence });
    if (reason !== null) {
      memory.stale = reason;
      return rebuiltAfter(memory, connection);
    }
    committed.push(change);
    sequence = followingSequence(sequence, change);
  }
  return applied(memory.held, { changes: committed, connection });
}

async function rebuiltAfter(
  memory: Memory,
  connection: SqlConnection,
): Promise<Held> {
  const held = await rebuilt(connection);
  if (memory.stale !== null)
    memory.logger.warn({
      event: "authority-projection-rebuilt",
      reason: memory.stale,
    });
  memory.stale = null;
  return held;
}

function mismatch(recorded: {
  readonly messageId: string;
  readonly change: ProjectedChange;
  readonly outcome: MessageOutcome;
  readonly sequence: number;
}): string | null {
  const { messageId, change, outcome, sequence } = recorded;
  if (outcome === "missing") return `message ${messageId} is not stored`;
  if (change.previous === sequence) return null;
  return `sequence ${String(change.previous)} does not follow ${String(sequence)}`;
}

async function rebuilt(connection: SqlConnection): Promise<Held> {
  const snapshot = await loadProjections(connection);
  return withProjection({
    snapshot,
    times: await runTimes(connection),
    workflows: new Map([
      ...snapshot.details.flatMap((row) =>
        row.submission === null ? [] : [[row.submission, null] as const],
      ),
      ...(await submittedWorkflows(connection)),
    ]),
  });
}

async function applied(
  previous: Held,
  input: {
    readonly changes: readonly ProjectedChange[];
    readonly connection: SqlConnection;
  },
): Promise<Held> {
  const { changes } = input;
  if (changes.length === 0) return previous;
  return withProjection({
    snapshot: changedProjection(previous.snapshot, changes),
    times: await changedTimes(previous.times, input),
    workflows: await changedWorkflows(previous.workflows, input),
  });
}

async function changedTimes(
  previous: ReadonlyMap<string, string>,
  input: {
    readonly changes: readonly ProjectedChange[];
    readonly connection: SqlConnection;
  },
): Promise<ReadonlyMap<string, string>> {
  const runs = new Map(
    input.changes.flatMap((change) =>
      change.runs.map((row) => [row.runId, row.sequence] as const),
    ),
  );
  const carried = new Map(
    input.changes.flatMap((change) =>
      change.events.map((event) => [event.sequence, event.recordedAt] as const),
    ),
  );
  const stored = await recordedTimes(input.connection, [
    ...new Set([...runs.values()].filter((sequence) => !carried.has(sequence))),
  ]);
  const times = new Map(previous);
  for (const [runId, sequence] of runs) {
    const time = carried.get(sequence) ?? stored.get(sequence);
    if (time === undefined) times.delete(runId);
    else times.set(runId, time);
  }
  return times;
}

async function changedWorkflows(
  previous: ReadonlyMap<string, string | null>,
  input: {
    readonly changes: readonly ProjectedChange[];
    readonly connection: SqlConnection;
  },
): Promise<ReadonlyMap<string, string | null>> {
  const submissions = [
    ...new Set(
      input.changes.flatMap((change) =>
        change.details.flatMap((row) =>
          row.submission === null || previous.has(row.submission)
            ? []
            : [row.submission],
        ),
      ),
    ),
  ];
  const stored = await storedWorkflows(input.connection, submissions);
  return new Map([
    ...previous,
    ...submissions.map(
      (submission) => [submission, stored.get(submission) ?? null] as const,
    ),
  ]);
}

function withProjection(parts: Omit<Held, "projection">): Held {
  return { ...parts, projection: projection(parts) };
}

function remembered<Value>(compute: () => Value): () => Value {
  let value: { readonly current: Value } | undefined;
  return () => {
    value ??= { current: compute() };
    return value.current;
  };
}

function projection(parts: Omit<Held, "projection">): Projection {
  const { snapshot, times, workflows } = parts;
  const state = remembered(() => currentState(snapshot));
  return {
    snapshot,
    state,
    eligible: remembered(() => eligible({ snapshot, state: state() })),
    operations: remembered(() => operationRecords(snapshot)),
    sequences: remembered(() => sequences({ snapshot, times })),
    workflowIds: (runIds) => workflowIds({ snapshot, workflows, runIds }),
  };
}

function sequences(parts: {
  readonly snapshot: ProjectionSnapshot;
  readonly times: ReadonlyMap<string, string>;
}): Sequences {
  const timed = parts.snapshot.runs.flatMap((row) => {
    const time = parts.times.get(row.runId);
    return time === undefined ? [] : [{ row, time }];
  });
  return {
    latest: parts.snapshot.sequence,
    runs: Object.fromEntries(timed.map(({ row }) => [row.runId, row.sequence])),
    times: Object.fromEntries(timed.map(({ row, time }) => [row.runId, time])),
  };
}

function workflowIds(parts: {
  readonly snapshot: ProjectionSnapshot;
  readonly workflows: ReadonlyMap<string, string | null>;
  readonly runIds: readonly string[] | undefined;
}): Readonly<Record<string, string>> {
  const wanted = parts.runIds === undefined ? null : new Set(parts.runIds);
  return Object.fromEntries(
    parts.snapshot.details.flatMap((row) => {
      const workflowId =
        row.submission === null ? null : parts.workflows.get(row.submission);
      if (typeof workflowId !== "string") return [];
      return wanted === null || wanted.has(row.runId)
        ? [[row.runId, workflowId]]
        : [];
    }),
  );
}

export function operationRecords(
  snapshot: Pick<ProjectionSnapshot, "outbox" | "deliveries">,
): readonly OperationRecord[] {
  const deliveries = Map.groupBy(snapshot.deliveries, (row) => row.operationId);
  return snapshot.outbox.map((row) => ({
    operationId: row.operationId,
    kind: intentKind(row.kind),
    runId: row.runId,
    createdSequence: row.createdSequence,
    releasedSequence: row.releasedSequence,
    deliveries: (deliveries.get(row.operationId) ?? []).map(
      ({ effectId, outcome, receipt, purpose, epoch }) => ({
        effectId,
        outcome,
        receipt,
        purpose,
        epoch,
      }),
    ),
  }));
}

function eligible(parts: {
  readonly snapshot: ProjectionSnapshot;
  readonly state: StoredState;
}): readonly EffectIntent[] {
  return eligibleIntents({
    ...parts.state,
    effects: {
      operations: Object.fromEntries(
        parts.snapshot.pending.map((operationId) => [
          operationId,
          { status: "dispatch-pending" },
        ]),
      ),
    },
  });
}
