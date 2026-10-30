import { operationalDecision } from "../decision-visibility.ts";
import { decisionLines, runStatus } from "../cli/render.ts";
import { record, type Fields } from "../protocol.ts";

export interface Notification {
  readonly event: "decision" | "blocked" | "failed" | "schedule-stopped";
  readonly runId: string;
  readonly workflowId: string;
  readonly subject: string;
  readonly body: string;
  readonly failedRunIds?: readonly string[];
}

export interface NotifyEvent {
  readonly key: string;
  readonly message: Notification;
}

function body(text: string, commands: readonly string[]): string {
  const tail = commands.join("\n");
  const available = 4000 - tail.length - 1;
  const shortened =
    text.length <= available ? text : `${text.slice(0, available - 1)}…`;
  return `${shortened}\n${tail}`;
}

function message(
  run: Fields,
  content: Pick<Notification, "event" | "body">,
): Notification {
  const workflowId = String(run["workflowId"]);
  const action =
    content.event === "decision" ? "waits for your decision" : content.event;
  return {
    ...content,
    runId: String(run["runId"]),
    workflowId,
    subject: `Cloving: ${workflowId} ${action}`.replace(/[\r\n]/g, " "),
  };
}

export function decisionNotification(
  run: Fields,
  decision: Fields,
): NotifyEvent {
  const lines = decisionLines(
    operationalDecision(decision, String(run["workflowId"])),
  );
  const allowed = decision["allowed"];
  const count = Array.isArray(allowed) ? allowed.length : 0;
  const split = lines.length - count;
  return {
    key: `decision:${String(decision["decisionId"])}`,
    message: message(run, {
      event: "decision",
      body: body(lines.slice(0, split).join("\n"), lines.slice(split)),
    }),
  };
}

export function outcomeNotification(run: Fields): NotifyEvent | undefined {
  const outcome = record(run["outcome"]);
  const blocked =
    run["state"] === "completed" && outcome?.["kind"] === "blocked";
  if (!blocked && run["state"] !== "failed") return undefined;
  const event = blocked ? "blocked" : "failed";
  const lines = runStatus({ run });
  return {
    key: `${event}:${String(run["runId"])}`,
    message: message(run, {
      event,
      body: body(String(lines[blocked ? 3 : 5]), [
        `cloving status ${String(run["runId"])}`,
      ]),
    }),
  };
}

export function stoppedScheduleNotification(
  schedule: Fields,
): NotifyEvent | undefined {
  if (schedule["state"] !== "stopped") return undefined;
  const failedRunIds = schedule["failedRunIds"];
  if (!Array.isArray(failedRunIds) || failedRunIds.length !== 3)
    throw new Error("invalid-stopped-schedule");
  const ids = failedRunIds.map((runId: unknown) => String(runId));
  const workflowId = String(schedule["workflowId"]);
  return {
    key: `schedule-stopped:${workflowId}:${String(schedule["stoppedSlot"])}`,
    message: {
      ...message(
        { workflowId, runId: ids[2] },
        {
          event: "schedule-stopped",
          body: body(
            `Schedule stopped after three failed runs:\n${ids.join("\n")}`,
            [`cloving schedule resume ${workflowId}`],
          ),
        },
      ),
      failedRunIds: ids,
    },
  };
}

export function scheduleStopNotifications(
  schedule: Fields,
): readonly NotifyEvent[] {
  const stops = schedule["stops"];
  if (stops === undefined) {
    const event = stoppedScheduleNotification(schedule);
    return event === undefined ? [] : [event];
  }
  if (!Array.isArray(stops)) throw new Error("invalid-stopped-schedule");
  return stops.flatMap((stop: unknown) => {
    const event = stoppedScheduleNotification({
      ...record(stop),
      workflowId: schedule["workflowId"],
      state: "stopped",
    });
    return event === undefined ? [] : [event];
  });
}
