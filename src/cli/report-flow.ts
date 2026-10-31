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

async function workflowIds(runtime: string, runIds: readonly string[]) {
  const identities = new Map<string, string | null>();
  for (let offset = 0; offset < runIds.length; offset += 500) {
    const batch = runIds.slice(offset, offset + 500);
    try {
      const reply = await send(runtime, {
        operation: "status",
        parameters: { metadata: "workflows", runIds: batch },
      });
      if (reply.kind === "error") continue;
      appendWorkflowIds(identities, {
        runIds: batch,
        values: reply.result["runs"],
      });
    } catch {
      continue;
    }
  }
  return identities;
}

function appendWorkflowIds(
  identities: Map<string, string | null>,
  batch: { readonly runIds: readonly string[]; readonly values: unknown },
) {
  const { values, runIds } = batch;
  if (!Array.isArray(values) || values.length !== runIds.length) return;
  const rows = values.map((value: unknown) => record(value));
  if (rows.some((row, index) => row?.["runId"] !== runIds[index])) return;
  for (const row of rows) {
    const id = row?.["workflowId"];
    identities.set(
      String(row?.["runId"]),
      typeof id === "string" && id !== "" ? id : null,
    );
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

function runsOf(input: {
  readonly events: readonly Fields[];
  readonly start: number;
  readonly completions: readonly ReportCompletion[] | null;
}): ReportFlow["runs"] {
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
      workflowId: null,
      start: at,
      end: ended.get(runId) ?? null,
    });
  }
  return runs.filter((run) => (run.end ?? Infinity) > input.start);
}

export async function readReportFlow(
  runtime: string,
  input: {
    readonly events: readonly Fields[] | null;
    readonly start: number;
    readonly completions: readonly ReportCompletion[] | null;
  },
): Promise<ReportFlow> {
  const settings = await overview(runtime).catch(() => ({
    queue: null,
    workflows: [],
  }));
  const runs =
    input.events === null ? null : runsOf({ ...input, events: input.events });
  const identities = await workflowIds(
    runtime,
    (runs ?? []).map((run) => run.runId),
  );
  return {
    ...settings,
    skips: skipsOf(input.events),
    runs:
      runs === null
        ? null
        : runs.map((run) => ({
            ...run,
            workflowId: identities.get(run.runId) ?? null,
          })),
  };
}
