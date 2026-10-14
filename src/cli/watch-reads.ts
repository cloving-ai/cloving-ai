import { record, type Fields, type ServiceRequest } from "../protocol.ts";
import { send } from "./client.ts";
import { activeRun, recentRun } from "./watch-board.ts";

export interface WatchRead {
  readonly service: string;
  readonly workflows: readonly string[];
  readonly summaries: readonly unknown[];
  readonly runs: readonly unknown[];
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
    { readonly sequence: unknown; readonly value: unknown }
  >;
}

const unavailable: WatchRead = {
  service: "down",
  workflows: [],
  summaries: [],
  runs: [],
  decisions: [],
};

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

async function asked(reader: Reader, request: ServiceRequest): Promise<Fields> {
  const reply = await send(reader.runtimeDirectory, request);
  if (reply.kind === "error") throw new Error(reply.error.code);
  return reply.result;
}

async function eventsOf(
  reader: Reader,
  runId: string,
): Promise<readonly unknown[]> {
  const events: unknown[] = [];
  let after = 0;
  for (;;) {
    const page = await asked(reader, {
      operation: "events",
      parameters: { runId, after, limit: 1000 },
    });
    const batch = list(page["events"]);
    events.push(...batch);
    if (batch.length < 1000) return events;
    const next = record(batch.at(-1))?.["sequence"];
    if (typeof next !== "number" || next <= after)
      throw new Error("invalid-event-page");
    after = next;
  }
}

async function detailed(reader: Reader, summary: unknown): Promise<unknown> {
  const run = record(summary);
  const runId = String(run?.["runId"]);
  const sequence = run?.["latestSequence"];
  const known = reader.details.get(runId);
  if (known !== undefined && known.sequence === sequence) return known.value;
  const shown = await asked(reader, {
    operation: "status",
    parameters: { runId },
  });
  return remember(reader, shown["run"]);
}

async function remember(reader: Reader, status: unknown): Promise<unknown> {
  const run = record(status);
  const runId = String(run?.["runId"]);
  const sequence = run?.["latestSequence"];
  const value = { status, events: await eventsOf(reader, runId) };
  reader.details.set(runId, { sequence, value });
  return value;
}

async function allRuns(
  reader: Reader,
  first: Fields,
): Promise<readonly unknown[]> {
  const runs = [...list(first["runs"])];
  let next = first["next"];
  const visited = new Set<string>();
  while (typeof next === "string") {
    if (visited.has(next)) throw new Error("invalid-run-page");
    visited.add(next);
    const page = await asked(reader, {
      operation: "status",
      parameters: { after: next },
    });
    runs.push(...list(page["runs"]));
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
  const runs: unknown[] = [];
  for (const summary of summaries) {
    const run = record(summary);
    const latestAt = run?.["latestAt"];
    if (
      activeRun(String(run?.["state"])) ||
      recentRun(typeof latestAt === "string" ? latestAt : null, now)
    )
      runs.push(await detailed(reader, summary));
  }
  return {
    service: "up",
    workflows: list(status["workflows"]).filter(
      (value) => typeof value === "string",
    ),
    summaries,
    runs,
    decisions: await decisionsOf(reader),
  };
}

async function singleRun(reader: Reader, runId: string): Promise<WatchRead> {
  const reply = await send(reader.runtimeDirectory, {
    operation: "status",
    parameters: { runId },
  });
  if (reply.kind === "error") {
    if (reply.error.code === "unknown-run") return unavailable;
    throw new Error(reply.error.code);
  }
  const status = reply.result["run"];
  const known = reader.details.get(runId);
  const value =
    known !== undefined && known.sequence === record(status)?.["latestSequence"]
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
