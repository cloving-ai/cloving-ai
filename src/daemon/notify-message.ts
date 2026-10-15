import { decisionLines, runStatus } from "../cli/render.ts";
import { record, type Fields } from "../protocol.ts";

export interface Notification {
  readonly event: "decision" | "blocked" | "failed";
  readonly runId: string;
  readonly workflowId: string;
  readonly subject: string;
  readonly body: string;
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
  const lines = decisionLines(decision);
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
