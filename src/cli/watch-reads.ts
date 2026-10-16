import { record, type Fields, type ServiceRequest } from "../protocol.ts";
import { send } from "./client.ts";
import { activeRun, recentRun } from "./watch-board.ts";

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
  readonly details: Map<
    string,
    { readonly sequence: number; readonly value: ReadRun }
  >;
}

const unavailable: WatchRead = {
  service: "down",
  workflows: [],
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

async function eventsOf(
  reader: Reader,
  runId: string,
): Promise<readonly ReadEvent[]> {
  const events: ReadEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await asked(reader, {
      operation: "events",
      parameters: { runId, after, limit: 1000 },
    });
    const batch = list(page["events"]).map(eventOf);
    events.push(...batch);
    if (batch.length < 1000) return events;
    const next = batch.at(-1)?.sequence;
    if (next === undefined || next <= after)
      throw new Error("invalid-event-page");
    after = next;
  }
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

async function service(reader: Reader, now: string): Promise<WatchRead> {
  const status = await asked(reader, {
    operation: "status",
    parameters: {},
  }).catch(() => null);
  if (status === null || !Array.isArray(status["runs"])) return unavailable;
  const summaries = await allRuns(reader, status);
  const runs: ReadRun[] = [];
  const completionCandidates: ReadRun[] = [];
  for (const summary of summaries) {
    if (activeRun(summary.state) || recentRun(summary.latestAt, now))
      runs.push(await detailed(reader, summary));
    else if (
      summary["workflowId"] === "develop-issue" &&
      summary.state === "completed"
    )
      completionCandidates.push(await detailed(reader, summary));
  }
  return {
    service: "up",
    workflows: list(status["workflows"]).filter(
      (value) => typeof value === "string",
    ),
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
  const reader: Reader = { runtimeDirectory, details: new Map() };
  return {
    read: (now) => service(reader, now),
    run: (runId) => singleRun(reader, runId),
  };
}
