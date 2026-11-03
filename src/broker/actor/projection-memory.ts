import type { Database, Logger } from "solid-objects";
import { eligibleIntents, type EffectIntent } from "../../authority/reducer.ts";
import {
  loadProjections,
  type ProjectionSnapshot,
} from "../../storage/decision-snapshots.ts";
import type { DomainChange } from "../../storage/domain-changes.ts";
import {
  integer,
  optionalText,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { changedProjection } from "../../storage/projection-changes.ts";
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
  readonly recorded: Map<string, DomainChange>;
  readonly logger: Logger;
}

const workflowColumn =
  "json_extract(s.body, '$.workflowId') AS workflow_id FROM documents s";
const workflowFilter =
  "json_valid(s.body) AND json_type(s.body, '$.workflowId') = 'text'";

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
      memory.recorded.set(messageId, change);
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
    readonly recorded: readonly (readonly [string, DomainChange])[];
    readonly connection: SqlConnection;
  },
): Promise<Held> {
  const { recorded, connection } = update;
  let held = memory.held ?? (await rebuiltAfter(memory, connection));
  for (const [messageId, change] of recorded) {
    const outcome = await messageOutcome(connection, messageId);
    if (outcome === "rolled-back") continue;
    const reason = mismatch(held, { messageId, change, outcome });
    if (reason !== null) {
      memory.stale = reason;
      return rebuiltAfter(memory, connection);
    }
    held = await applied(held, { change, connection });
  }
  return held;
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

type MessageOutcome = "committed" | "rolled-back" | "missing";

async function messageOutcome(
  connection: SqlConnection,
  messageId: string,
): Promise<MessageOutcome> {
  const row = await connection.get(
    "SELECT completed_at_ms IS NOT NULL AND rejection IS NULL AND error IS NULL AS committed FROM solid_messages WHERE id = ?",
    [messageId],
  );
  if (row === undefined) return "missing";
  return integer(row, "committed") === 1 ? "committed" : "rolled-back";
}

function mismatch(
  held: Held,
  recorded: {
    readonly messageId: string;
    readonly change: DomainChange;
    readonly outcome: MessageOutcome;
  },
): string | null {
  const { messageId, change, outcome } = recorded;
  if (outcome === "missing") return `message ${messageId} is not stored`;
  if (change.previous === held.snapshot.sequence) return null;
  return `sequence ${String(change.previous)} does not follow ${String(held.snapshot.sequence)}`;
}

async function rebuilt(connection: SqlConnection): Promise<Held> {
  const snapshot = await loadProjections(connection);
  const times = await connection.all(
    "SELECT r.run_id, e.recorded_at FROM runs r JOIN events e ON e.sequence = r.sequence",
  );
  const workflows = new Map<string, string | null>(
    snapshot.details.flatMap((row) =>
      row.submission === null ? [] : [[row.submission, null]],
    ),
  );
  for (const row of await connection.all(
    `SELECT DISTINCT s.digest, ${workflowColumn} JOIN run_details d ON d.submission = s.digest WHERE ${workflowFilter}`,
  ))
    workflows.set(text(row, "digest"), text(row, "workflow_id"));
  return withProjection({
    snapshot,
    times: new Map(
      times.map((row) => [text(row, "run_id"), text(row, "recorded_at")]),
    ),
    workflows,
  });
}

async function applied(
  previous: Held,
  input: { readonly change: DomainChange; readonly connection: SqlConnection },
): Promise<Held> {
  const { change, connection } = input;
  const snapshot = changedProjection(previous.snapshot, change);
  const times = new Map(previous.times);
  for (const row of change.runs) {
    const time =
      change.events.find((event) => event.sequence === row.sequence)
        ?.recordedAt ?? (await recordedAt(connection, row.sequence));
    if (time === null) times.delete(row.runId);
    else times.set(row.runId, time);
  }
  const workflows = new Map(previous.workflows);
  for (const row of change.details)
    if (row.submission !== null && !workflows.has(row.submission))
      workflows.set(
        row.submission,
        await workflowOf(connection, row.submission),
      );
  return withProjection({ snapshot, times, workflows });
}

async function recordedAt(
  connection: SqlConnection,
  sequence: number,
): Promise<string | null> {
  const row = await connection.get(
    "SELECT recorded_at FROM events WHERE sequence = ?",
    [sequence],
  );
  return row === undefined ? null : text(row, "recorded_at");
}

async function workflowOf(
  connection: SqlConnection,
  digest: string,
): Promise<string | null> {
  const row = await connection.get(
    `SELECT ${workflowColumn} WHERE s.digest = ? AND ${workflowFilter}`,
    [digest],
  );
  return row === undefined ? null : optionalText(row, "workflow_id");
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
