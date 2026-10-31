import { record, type Fields } from "../protocol.ts";
import type {
  ReportFlow,
  ReportFlowRun,
  ReportCompletion,
} from "../report-flow-types.ts";
import { send } from "./client.ts";

function queueOf(value: unknown): ReportFlow["queue"] {
  const queue = record(value);
  const workflowId = queue?.["workflowId"];
  const lanes = queue?.["lanes"];
  return typeof workflowId === "string" &&
    workflowId !== "" &&
    typeof lanes === "number" &&
    Number.isSafeInteger(lanes) &&
    lanes > 0
    ? { workflowId, lanes }
    : null;
}

async function overview(runtime: string) {
  const reply = await send(runtime, {
    operation: "status",
    parameters: { limit: 1 },
  });
  if (reply.kind === "error") throw new Error("report-overview-unavailable");
  const workflows = reply.result["workflows"];
  return {
    queue: queueOf(reply.result["queue"]),
    workflows: Array.isArray(workflows)
      ? workflows.filter((id: unknown): id is string => typeof id === "string")
      : [],
  };
}

async function workflowId(
  runtime: string,
  runId: string,
): Promise<string | null> {
  try {
    const reply = await send(runtime, {
      operation: "status",
      parameters: { runId },
    });
    if (reply.kind === "error") return null;
    const run = record(reply.result["run"]);
    const id = run?.["workflowId"];
    return run?.["runId"] === runId && typeof id === "string" && id !== ""
      ? id
      : null;
  } catch {
    return null;
  }
}

function skipsOf(
  events: readonly Fields[] | null,
): Exclude<ReportFlow["skips"], undefined> {
  if (events === null) return null;
  const skips = [];
  for (const event of events.filter(
    (event) => event["type"] === "schedule.skipped",
  )) {
    const id = record(event["payload"])?.["workflowId"];
    const at = Date.parse(String(event["recordedAt"]));
    const sequence = event["sequence"];
    if (
      typeof id !== "string" ||
      id === "" ||
      !Number.isFinite(at) ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      return null;
    skips.push({ workflowId: id, at, sequence });
  }
  return skips;
}

async function runsOf(
  runtime: string,
  input: {
    readonly events: readonly Fields[];
    readonly completions: readonly ReportCompletion[] | null;
  },
): Promise<ReportFlow["runs"]> {
  const runs: ReportFlowRun[] = [];
  const ended = new Map(
    (input.completions ?? []).map((event) => [event.runId, event.at]),
  );
  const seen = new Set<string>();
  for (const event of input.events.filter(
    (event) => event["type"] === "run.started",
  )) {
    const runId = event["runId"];
    const at = Date.parse(String(event["recordedAt"]));
    if (
      typeof runId !== "string" ||
      !Number.isFinite(at) ||
      seen.has(runId) ||
      (ended.get(runId) ?? at) < at
    )
      return null;
    seen.add(runId);
    runs.push({
      runId,
      workflowId: await workflowId(runtime, runId),
      start: at,
      end: ended.get(runId) ?? null,
    });
  }
  return runs;
}

export async function readReportFlow(
  runtime: string,
  input: {
    readonly events: readonly Fields[] | null;
    readonly completions: readonly ReportCompletion[] | null;
  },
): Promise<ReportFlow> {
  const settings = await overview(runtime).catch(() => ({
    queue: null,
    workflows: [],
  }));
  return {
    ...settings,
    skips: skipsOf(input.events),
    runs:
      input.events === null
        ? null
        : await runsOf(runtime, {
            events: input.events,
            completions: input.completions,
          }),
  };
}
