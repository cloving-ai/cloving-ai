import { record, type Fields } from "./protocol.ts";

export type RunAlertKind = "paused" | "failed" | "blocked";

export type Alert =
  | {
      readonly kind: "decision";
      readonly key: string;
      readonly run: Fields;
      readonly decision: Fields;
    }
  | { readonly kind: RunAlertKind; readonly key: string; readonly run: Fields }
  | {
      readonly kind: "schedule-stopped";
      readonly key: string;
      readonly workflowId: string;
      readonly failedRunIds: readonly string[];
    };

export function decisionAlert(run: Fields, decision: Fields): Alert {
  return {
    kind: "decision",
    key: `decision:${String(decision["decisionId"])}`,
    run,
    decision,
  };
}

function stoppedKind(run: Fields): RunAlertKind | undefined {
  if (run["state"] === "paused") return "paused";
  if (typeof run["continuedBy"] === "string" || run["dismissed"] === true)
    return undefined;
  if (run["state"] === "failed") return "failed";
  const blocked =
    run["state"] === "completed" &&
    record(run["outcome"])?.["kind"] === "blocked";
  return blocked ? "blocked" : undefined;
}

export function runAlert(run: Fields): Alert | undefined {
  const kind = stoppedKind(run);
  if (kind === undefined) return undefined;
  return { kind, key: `${kind}:${String(run["runId"])}`, run };
}

export function stoppedScheduleAlert(schedule: Fields): Alert | undefined {
  if (schedule["state"] !== "stopped") return undefined;
  const failedRunIds = schedule["failedRunIds"];
  if (!Array.isArray(failedRunIds) || failedRunIds.length !== 3)
    throw new Error("invalid-stopped-schedule");
  const workflowId = String(schedule["workflowId"]);
  return {
    kind: "schedule-stopped",
    key: `schedule-stopped:${workflowId}:${String(schedule["stoppedSlot"])}`,
    workflowId,
    failedRunIds: failedRunIds.map((runId: unknown) => String(runId)),
  };
}

export function scheduleStopAlerts(schedule: Fields): readonly Alert[] {
  const stops = schedule["stops"];
  if (stops === undefined) {
    const alert = stoppedScheduleAlert(schedule);
    return alert === undefined ? [] : [alert];
  }
  if (!Array.isArray(stops)) throw new Error("invalid-stopped-schedule");
  return stops.flatMap((stop: unknown) => {
    const alert = stoppedScheduleAlert({
      ...record(stop),
      workflowId: schedule["workflowId"],
      state: "stopped",
    });
    return alert === undefined ? [] : [alert];
  });
}
