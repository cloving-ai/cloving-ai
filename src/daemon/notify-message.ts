import {
  decisionAlert,
  runAlert,
  stoppedScheduleAlert,
  type Alert,
} from "../alert-selection.ts";
import { operationalDecision } from "../decision-visibility.ts";
import { decisionLines, runStatus } from "../cli/render.ts";
import type { Fields } from "../protocol.ts";

export interface Notification {
  readonly event:
    "decision" | "paused" | "blocked" | "failed" | "schedule-stopped";
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

function decisionEvent(alert: Extract<Alert, { kind: "decision" }>) {
  const { run, decision } = alert;
  const lines = decisionLines(
    operationalDecision(decision, String(run["workflowId"])),
  );
  const allowed = decision["allowed"];
  const count = Array.isArray(allowed) ? allowed.length : 0;
  const split = lines.length - count;
  return {
    key: alert.key,
    message: message(run, {
      event: "decision",
      body: body(lines.slice(0, split).join("\n"), lines.slice(split)),
    }),
  };
}

function scheduleEvent(alert: Extract<Alert, { kind: "schedule-stopped" }>) {
  const { workflowId, failedRunIds } = alert;
  return {
    key: alert.key,
    message: {
      ...message(
        { workflowId, runId: failedRunIds[2] },
        {
          event: "schedule-stopped",
          body: body(
            `Schedule stopped after three failed runs:\n${failedRunIds.join("\n")}`,
            [`cloving schedule resume ${workflowId}`],
          ),
        },
      ),
      failedRunIds,
    },
  };
}

export function notifyEvent(alert: Alert): NotifyEvent {
  if (alert.kind === "decision") return decisionEvent(alert);
  if (alert.kind === "schedule-stopped") return scheduleEvent(alert);
  const wanted = alert.kind === "blocked" ? "Outcome:" : "Reason:";
  const line = runStatus({ run: alert.run }).find((text) =>
    text.startsWith(wanted),
  );
  return {
    key: alert.key,
    message: message(alert.run, {
      event: alert.kind,
      body: body(String(line), [
        `cloving status ${String(alert.run["runId"])}`,
      ]),
    }),
  };
}

export function decisionNotification(
  run: Fields,
  decision: Fields,
): NotifyEvent {
  return notifyEvent(decisionAlert(run, decision));
}

export function outcomeNotification(run: Fields): NotifyEvent | undefined {
  const alert = runAlert(run);
  return alert === undefined ? undefined : notifyEvent(alert);
}

export function stoppedScheduleNotification(
  schedule: Fields,
): NotifyEvent | undefined {
  const alert = stoppedScheduleAlert(schedule);
  return alert === undefined ? undefined : notifyEvent(alert);
}
