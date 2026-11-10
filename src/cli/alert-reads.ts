import {
  decisionAlert,
  runAlert,
  scheduleStopAlerts,
  stoppedScheduleAlert,
  type Alert,
} from "../alert-selection.ts";
import { record, type Fields, type ServiceRequest } from "../protocol.ts";
import { send } from "./client.ts";

export type RunCache = Map<
  string,
  {
    readonly latestSequence: number;
    readonly run: Fields;
    readonly alert: Alert | undefined;
  }
>;

async function read(
  runtimeDirectory: string,
  request: ServiceRequest,
): Promise<Fields> {
  const reply = await send(runtimeDirectory, request);
  if (reply.kind === "error") throw new Error(reply.error.code);
  return reply.result;
}

function rows(value: unknown): readonly Fields[] {
  if (!Array.isArray(value)) throw new Error("invalid-alert-list");
  return value.map((item: unknown) => {
    const row = record(item);
    if (row === undefined) throw new Error("invalid-alert-row");
    return row;
  });
}

function shownRun(status: Fields): Fields {
  const run = record(status["run"]);
  if (run === undefined) throw new Error("invalid-alert-status");
  return run;
}

async function scheduleList(runtimeDirectory: string): Promise<Fields> {
  const reply = await send(runtimeDirectory, {
    operation: "schedule",
    parameters: { action: "list" },
  });
  if (reply.kind !== "error") return reply.result;
  if (reply.error.code === "schedules-unavailable")
    return { stops: [], schedules: [] };
  throw new Error(reply.error.code);
}

export async function scheduleAlerts(
  runtimeDirectory: string,
): Promise<readonly Alert[]> {
  const list = await scheduleList(runtimeDirectory);
  return rows(list["stops"]).flatMap(scheduleStopAlerts);
}

export async function openScheduleAlerts(
  runtimeDirectory: string,
): Promise<readonly Alert[]> {
  const list = await scheduleList(runtimeDirectory);
  return rows(list["schedules"]).flatMap(
    (schedule) => stoppedScheduleAlert(schedule) ?? [],
  );
}

async function observedRun(
  summary: Fields,
  source: { readonly runtimeDirectory: string; readonly cache: RunCache },
): Promise<{ readonly run: Fields; readonly alert: Alert | undefined }> {
  const { runtimeDirectory, cache } = source;
  const latestSequence = summary["latestSequence"];
  if (typeof latestSequence !== "number")
    throw new Error("invalid-alert-sequence");
  const runId = String(summary["runId"]);
  const previous = cache.get(runId);
  if (previous !== undefined && previous.latestSequence === latestSequence)
    return previous;
  const run = shownRun(
    await read(runtimeDirectory, {
      operation: "status",
      parameters: { runId },
    }),
  );
  const observed = { latestSequence, run, alert: runAlert(run) };
  cache.set(runId, observed);
  return observed;
}

async function scannedRuns(
  runtimeDirectory: string,
  cache: RunCache,
): Promise<ReadonlyMap<string, Fields>> {
  const runs = new Map<string, Fields>();
  let after: string | null = "";
  do {
    const page = await read(runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500 },
    });
    for (const summary of rows(page["runs"])) {
      const observed = await observedRun(summary, { runtimeDirectory, cache });
      runs.set(String(summary["runId"]), observed.run);
    }
    const next = page["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-alert-page");
    after = next;
  } while (after !== null);
  for (const runId of cache.keys()) if (!runs.has(runId)) cache.delete(runId);
  return runs;
}

export async function runScan(
  runtimeDirectory: string,
  cache: RunCache,
): Promise<readonly Alert[]> {
  const runs = await scannedRuns(runtimeDirectory, cache);
  const found = [...cache.values()].flatMap((observed) =>
    observed.alert === undefined ? [] : [observed.alert],
  );
  const questions = await read(runtimeDirectory, {
    operation: "questions",
    parameters: {},
  });
  for (const decision of rows(questions["decisions"])) {
    const run = runs.get(String(decision["runId"]));
    if (run !== undefined) found.push(decisionAlert(run, decision));
  }
  return found;
}

export async function runAlerts(
  runtimeDirectory: string,
  runId: string,
): Promise<readonly Alert[]> {
  const status = await send(runtimeDirectory, {
    operation: "status",
    parameters: { runId },
  });
  if (status.kind === "error" && status.error.code === "unknown-run") return [];
  if (status.kind === "error") throw new Error(status.error.code);
  const run = shownRun(status.result);
  const questions = await read(runtimeDirectory, {
    operation: "questions",
    parameters: { runId },
  });
  const decisions = rows(questions["decisions"]).map((decision) =>
    decisionAlert(run, decision),
  );
  const alert = runAlert(run);
  return alert === undefined ? decisions : [alert, ...decisions];
}
