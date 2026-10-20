import {
  isWorkflowStages,
  type WorkflowStages,
} from "../workflow-declaration.ts";
import { record, type Fields, type ServiceRequest } from "../protocol.ts";
import { send } from "./client.ts";
import { activeRun, recentRun } from "./watch-board.ts";
import {
  workflowRefusals,
  type WorkflowRefusal,
} from "../workflow-refusals.ts";

interface ReadStatus extends Fields {
  readonly runId: string;
  readonly latestSequence: number;
  readonly state: string;
  readonly latestAt: string | null;
}

interface ReadEvent extends Fields {
  readonly sequence: number;
}

interface ReadRun {
  readonly status: ReadStatus;
  readonly events: readonly ReadEvent[];
}

export interface WatchRead {
  readonly service: string;
  readonly workflows: readonly string[];
  readonly workflowRefusals: readonly WorkflowRefusal[];
  readonly workflowStages?: WorkflowStages;
  readonly summaries: readonly ReadStatus[];
  readonly runs: readonly ReadRun[];
  readonly completionCandidates: readonly ReadRun[];
  readonly decisions: readonly unknown[];
}

export interface WatchReader {
  readonly read: (now: string) => Promise<WatchRead>;
  readonly run: (runId: string) => Promise<WatchRead>;
}

interface Reader {
  readonly runtimeDirectory: string;
  readonly completions: Map<
    string,
    { readonly status: ReadStatus; readonly creation?: ReadEvent | null }
  >;
  readonly details: Map<
    string,
    { readonly sequence: number; readonly value: ReadRun }
  >;
}

const unavailable: WatchRead = {
  service: "down",
  workflows: [],
  workflowRefusals: [],
  summaries: [],
  runs: [],
  completionCandidates: [],
  decisions: [],
};

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function statusOf(value: unknown): ReadStatus {
  const fields = record(value);
  const runId = fields?.["runId"];
  const latestSequence = fields?.["latestSequence"];
  const state = fields?.["state"];
  const latestAt = fields?.["latestAt"];
  if (
    typeof runId !== "string" ||
    typeof latestSequence !== "number" ||
    typeof state !== "string"
  )
    throw new Error("invalid-run-status");
  return {
    ...fields,
    runId,
    latestSequence,
    state,
    latestAt: typeof latestAt === "string" ? latestAt : null,
  };
}

function eventOf(value: unknown): ReadEvent {
  const fields = record(value);
  const sequence = fields?.["sequence"];
  if (typeof sequence !== "number") throw new Error("invalid-event-page");
  return { ...fields, sequence };
}

async function asked(reader: Reader, request: ServiceRequest): Promise<Fields> {
  const reply = await send(reader.runtimeDirectory, request);
  if (reply.kind === "error") throw new Error(reply.error.code);
  return reply.result;
}

async function* eventPages(
  reader: Reader,
  cursor: { readonly runId: string; readonly firstLimit?: number },
): AsyncGenerator<readonly ReadEvent[]> {
  let after = 0;
  for (;;) {
    const limit = after === 0 ? (cursor.firstLimit ?? 1000) : 1000;
    const page = await asked(reader, {
      operation: "events",
      parameters: { runId: cursor.runId, after, limit },
    });
    const batch = list(page["events"]).map(eventOf);
    yield batch;
    if (batch.length < limit) return;
    const next = batch.at(-1)?.sequence;
    if (next === undefined || next <= after)
      throw new Error("invalid-event-page");
    after = next;
  }
}

async function eventsOf(
  reader: Reader,
  runId: string,
): Promise<readonly ReadEvent[]> {
  const events: ReadEvent[] = [];
  for await (const batch of eventPages(reader, { runId }))
    events.push(...batch);
  return events;
}

async function creationOf(
  reader: Reader,
  runId: string,
): Promise<ReadEvent | null> {
  for await (const batch of eventPages(reader, { runId, firstLimit: 1 })) {
    const event = batch.find((value) => value["type"] === "run.created");
    if (event !== undefined)
      return {
        sequence: event.sequence,
        type: event["type"],
        recordedAt: event["recordedAt"],
      };
  }
  return null;
}

function matchingCompletion(
  status: ReadStatus,
  ticketIds: ReadonlySet<string>,
): boolean {
  const ticketId = status["ticketId"];
  return (
    status.state === "completed" &&
    status["workflowId"] === "develop-issue" &&
    record(status["outcome"])?.["kind"] === "handoff_requested" &&
    record(status["outcome"])?.["ticketStatus"] !== "partial" &&
    record(status["outcome"])?.["issueUpdate"] !== "failed" &&
    typeof ticketId === "string" &&
    ticketIds.has(ticketId)
  );
}

async function completionOf(
  reader: Reader,
  search: {
    readonly summary: ReadStatus;
    readonly ticketIds: ReadonlySet<string>;
  },
): Promise<ReadRun | null> {
  const { runId, latestSequence } = search.summary;
  let known = reader.completions.get(runId);
  if (known?.status.latestSequence !== latestSequence) {
    const shown = await asked(reader, {
      operation: "status",
      parameters: { runId },
    });
    const status = statusOf(shown["run"]);
    known = {
      status: {
        runId,
        latestSequence: status.latestSequence,
        latestAt: status.latestAt,
        state: status.state,
        workflowId: status["workflowId"],
        ticketId: status["ticketId"],
        outcome: status["outcome"],
      },
    };
    reader.completions.set(runId, known);
  }
  if (!matchingCompletion(known.status, search.ticketIds)) return null;
  const creation =
    known.creation === undefined
      ? await creationOf(reader, runId)
      : known.creation;
  reader.completions.set(runId, { ...known, creation });
  return { status: known.status, events: creation === null ? [] : [creation] };
}

async function detailed(reader: Reader, summary: ReadStatus): Promise<ReadRun> {
  const { runId, latestSequence: sequence } = summary;
  const known = reader.details.get(runId);
  if (known !== undefined && known.sequence === sequence) return known.value;
  const shown = await asked(reader, {
    operation: "status",
    parameters: { runId },
  });
  return remember(reader, statusOf(shown["run"]));
}

async function remember(reader: Reader, status: ReadStatus): Promise<ReadRun> {
  const { runId, latestSequence: sequence } = status;
  const value = { status, events: await eventsOf(reader, runId) };
  reader.details.set(runId, { sequence, value });
  return value;
}

async function allRuns(
  reader: Reader,
  first: Fields,
): Promise<readonly ReadStatus[]> {
  const runs = list(first["runs"]).map(statusOf);
  let next = first["next"];
  const visited = new Set<string>();
  while (typeof next === "string") {
    if (visited.has(next)) throw new Error("invalid-run-page");
    visited.add(next);
    const page = await asked(reader, {
      operation: "status",
      parameters: { after: next },
    });
    runs.push(...list(page["runs"]).map(statusOf));
    next = page["next"];
  }
  return runs;
}

async function decisionsOf(reader: Reader): Promise<readonly unknown[]> {
  const questions = await asked(reader, {
    operation: "questions",
    parameters: {},
  });
  return list(questions["decisions"]);
}

function stoppedTicketIds(
  runs: readonly ReadRun[],
  now: string,
): ReadonlySet<string> {
  const stopped = runs
    .map((run) => run.status)
    .filter(
      (status) =>
        recentRun(status.latestAt, now) &&
        status["workflowId"] === "develop-issue" &&
        (["failed", "cancelled"].includes(status.state) ||
          (status.state === "completed" &&
            record(status["outcome"])?.["kind"] === "blocked")),
    )
    .toSorted(
      (first, second) =>
        Date.parse(second.latestAt ?? "") - Date.parse(first.latestAt ?? ""),
    )
    .slice(0, 20);
  return new Set(
    stopped.flatMap((status) => {
      const ticketId = status["ticketId"];
      return status.state === "completed" &&
        record(status["outcome"])?.["ticketStatus"] !== "partial" &&
        record(status["outcome"])?.["issueUpdate"] !== "failed" &&
        typeof ticketId === "string" &&
        ticketId !== ""
        ? [ticketId]
        : [];
    }),
  );
}

function stageMetadata(value: unknown): WorkflowStages {
  return Object.fromEntries(
    Object.entries(record(value) ?? {}).flatMap(([workflowId, stages]) =>
      isWorkflowStages(stages) ? [[workflowId, stages]] : [],
    ),
  );
}

async function service(reader: Reader, now: string): Promise<WatchRead> {
  const status = await asked(reader, {
    operation: "status",
    parameters: {},
  }).catch(() => null);
  if (status === null || !Array.isArray(status["runs"])) return unavailable;
  const summaries = await allRuns(reader, status);
  const runs: ReadRun[] = [];
  const completionCandidates: ReadRun[] = [];
  const current = summaries.filter(
    (summary) => activeRun(summary.state) || recentRun(summary.latestAt, now),
  );
  for (const summary of current) runs.push(await detailed(reader, summary));
  const ticketIds = stoppedTicketIds(runs, now);
  const older =
    ticketIds.size === 0
      ? []
      : summaries.filter(
          (summary) =>
            !recentRun(summary.latestAt, now) &&
            summary["workflowId"] === "develop-issue" &&
            summary.state === "completed",
        );
  for (const summary of older) {
    const candidate = await completionOf(reader, { summary, ticketIds });
    if (candidate !== null) completionCandidates.push(candidate);
  }
  return {
    service: "up",
    workflows: list(status["workflows"]).filter(
      (value) => typeof value === "string",
    ),
    workflowStages: stageMetadata(status["workflowStages"]),
    workflowRefusals: workflowRefusals(status["workflowRefusals"]),
    summaries,
    runs,
    completionCandidates,
    decisions: await decisionsOf(reader),
  };
}

async function singleRun(reader: Reader, runId: string): Promise<WatchRead> {
  const reply = await send(reader.runtimeDirectory, {
    operation: "status",
    parameters: { runId },
  });
  if (reply.kind === "error" && reply.error.code === "unknown-run")
    return unavailable;
  if (reply.kind === "error") throw new Error(reply.error.code);
  const status = statusOf(reply.result["run"]);
  const known = reader.details.get(runId);
  const value =
    known !== undefined && known.sequence === status.latestSequence
      ? known.value
      : await remember(reader, status);
  return {
    ...unavailable,
    service: "up",
    runs: [value],
    decisions: await decisionsOf(reader),
  };
}

export function watchReader(runtimeDirectory: string): WatchReader {
  const reader: Reader = {
    runtimeDirectory,
    details: new Map(),
    completions: new Map(),
  };
  return {
    read: (now) => service(reader, now),
    run: (runId) => singleRun(reader, runId),
  };
}
