import { record, type Fields } from "../protocol.ts";
import { show } from "./terminal-text.ts";
import { listing } from "./run-command-render.ts";
import { workflowRefusals } from "../workflow-refusals.ts";

export function restartPendingText(restart: Fields): string {
  const count = Number(restart["activeRuns"]);
  const runs = count === 1 ? "run" : "runs";
  return `Restart pending: ${String(count)} ${runs} active`;
}

function pendingLines(restart: Fields | undefined): readonly string[] {
  return restart === undefined ? [] : [restartPendingText(restart)];
}

export function serviceOf(status: Fields): {
  readonly serviceVersion?: string;
  readonly restart?: Fields;
} {
  const version = status["serviceVersion"];
  const restart = record(status["restart"]);
  return {
    ...(typeof version === "string" ? { serviceVersion: version } : {}),
    ...(restart === undefined ? {} : { restart }),
  };
}

export function serviceLines(result: Fields): readonly string[] {
  const startedAt = result["serviceStartedAt"];
  return [
    ...(typeof startedAt === "string"
      ? [
          `Service: commit ${show(result["serviceCommit"] ?? "unknown")}, started at ${startedAt}`,
        ]
      : []),
    ...pendingLines(record(result["restart"])),
  ];
}

const cancelLines: Readonly<Record<string, string>> = {
  cancelled: "Restart: cancelled",
  none: "Restart: none pending",
  started: "Restart: started, cannot cancel",
};

function unresumableLines(restart: Fields | undefined): readonly string[] {
  const runs = restart?.["unresumableRuns"];
  return Array.isArray(runs)
    ? [`Runs with a turn that cannot resume: ${listing(runs)}`]
    : [];
}

export function restartLines(result: Fields): readonly string[] {
  const restart = record(result["restart"]);
  const cancelled = cancelLines[String(restart?.["state"])];
  if (cancelled !== undefined) return [cancelled];
  return [...pendingLines(restart), ...unresumableLines(restart)];
}

function commitOf(fields: Fields): string | null {
  const commit = fields["serviceCommit"];
  return typeof commit === "string" ? commit : null;
}

interface Restarted {
  readonly before: Fields;
  readonly after: Fields;
  readonly update: Fields | undefined;
}

function admittedIds(after: Fields): readonly string[] {
  const workflows = after["workflows"];
  return Array.isArray(workflows)
    ? workflows.filter((workflow) => typeof workflow === "string")
    : [];
}

function lanesOf(after: Fields): unknown {
  return record(after["queue"])?.["lanes"];
}

function lanesLines(after: Fields): readonly string[] {
  const lanes = lanesOf(after);
  return lanes === undefined ? [] : [`Lanes: ${show(lanes)}`];
}

function indented(output: unknown): readonly string[] {
  return show(output)
    .split("\n")
    .map((line) => `    ${line}`);
}

function updateLines(update: Fields | undefined): readonly string[] {
  if (update?.["code"] !== "restart-update-skipped") return [];
  return [
    "Update skipped: the checkout has local changes.",
    ...indented(update["output"]),
  ];
}

type RecoveryList = "connected" | "resumed" | "waiting" | "commands";

const recoveryLists = ["connected", "resumed", "waiting", "commands"] as const;

function recoveredRuns(after: Fields, way: RecoveryList): readonly string[] {
  const runs = record(after["turnRecovery"])?.[way];
  return Array.isArray(runs)
    ? runs.filter((runId) => typeof runId === "string")
    : [];
}

const recoveryHeadings = {
  connected: "Turns connected again",
  resumed: "Turns resumed",
  waiting: "Turns that wait for a retry",
  commands: "Commands connected again",
} as const;

function recoveryLines(after: Fields): readonly string[] {
  return recoveryLists.flatMap((way) => {
    const runs = recoveredRuns(after, way);
    return runs.length === 0
      ? []
      : [`${recoveryHeadings[way]}: ${runs.map(show).join(", ")}`];
  });
}

function recoveredTurns(after: Fields): Fields {
  if (record(after["turnRecovery"]) === undefined) return {};
  return {
    turns: Object.fromEntries(
      recoveryLists.map((way) => [way, recoveredRuns(after, way)]),
    ),
  };
}

export function restartedLines(restarted: Restarted): readonly string[] {
  const { before, after } = restarted;
  return [
    `Restarted: commit ${show(commitOf(before) ?? "unknown")} -> ${show(commitOf(after) ?? "unknown")}`,
    `Started at: ${show(after["serviceStartedAt"])}`,
    ...lanesLines(after),
    ...admittedIds(after).map(
      (workflowId) => `Workflow ${show(workflowId)}: admitted`,
    ),
    ...workflowRefusals(after["workflowRefusals"]).map(
      (refusal) =>
        `Workflow ${show(refusal.label)}: refused: ${refusal.codes.map(show).join(", ")}`,
    ),
    ...recoveryLines(after),
    ...updateLines(restarted.update),
  ];
}

function watchedWorkflows(
  before: Fields,
): readonly (readonly [string, string])[] {
  const restart = record(before["restart"]) ?? {};
  const queue = restart["queueWorkflowId"];
  const scheduled = restart["scheduledWorkflowIds"];
  return [
    ...(typeof queue === "string" ? [["queue workflow", queue] as const] : []),
    ...(Array.isArray(scheduled) ? scheduled : [])
      .filter((workflowId) => typeof workflowId === "string")
      .map((workflowId) => ["scheduled workflow", workflowId] as const),
  ];
}

function refusalCodes(after: Fields, workflowId: string): readonly string[] {
  const refusals = workflowRefusals(after["workflowRefusals"]);
  const own =
    refusals.find((refusal) => refusal.label === `${workflowId}.ts`) ??
    refusals.find((refusal) => refusal.label === "workflows/");
  return own?.codes ?? ["workflow-missing"];
}

export function refusedWorkflowLines(
  before: Fields,
  after: Fields,
): readonly string[] {
  const admitted = admittedIds(after);
  return watchedWorkflows(before)
    .filter(([, workflowId]) => !admitted.includes(workflowId))
    .map(
      ([kind, workflowId]) =>
        `${kind} ${show(workflowId)}: ${refusalCodes(after, workflowId).map(show).join(", ")}`,
    );
}

export function restartedJson(restarted: Restarted): Fields {
  const { before, after, update } = restarted;
  return {
    kind: "restarted",
    previousCommit: commitOf(before),
    commit: commitOf(after),
    startedAt: after["serviceStartedAt"] ?? null,
    lanes: lanesOf(after) ?? null,
    workflows: admittedIds(after),
    workflowRefusals: workflowRefusals(after["workflowRefusals"]),
    ...recoveredTurns(after),
    ...(update === undefined ? {} : { update }),
  };
}
