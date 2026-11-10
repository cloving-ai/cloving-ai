import type { Alert } from "./alert-selection.ts";
import { operationalDecision } from "./decision-visibility.ts";
import { record, type Fields } from "./protocol.ts";
import { maskedText, withoutControls } from "./transcript-text.ts";

export interface ChannelMessage {
  readonly content: string;
  readonly meta: Readonly<Record<string, string>>;
}

interface Shown {
  readonly run: Fields;
  readonly privateTexts: readonly string[];
}

const shownLimit = 300;

const answers: Readonly<Record<string, readonly [string, string]>> = {
  approval: [
    "waits for your approval",
    "Answer with cloving_questions and cloving_approve or cloving_deny.",
  ],
  question: [
    "asks a question",
    "Answer with cloving_questions and cloving_answer.",
  ],
};

const continued =
  "Continue it with cloving_continue, or dismiss it with cloving_dismiss.";

const stops: Readonly<Record<string, readonly [string, string]>> = {
  paused: [
    "is paused",
    "Resume it with cloving_resume, or drop it with cloving_drop.",
  ],
  failed: ["failed", continued],
  blocked: ["is blocked", continued],
};

function firstLine(value: unknown): string {
  return (
    withoutControls(typeof value === "string" ? value : "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function shown(value: unknown, privateTexts: readonly string[]): string {
  const characters = Array.from(maskedText(firstLine(value), privateTexts));
  return characters.length > shownLimit
    ? `${characters.slice(0, shownLimit - 1).join("")}…`
    : characters.join("");
}

function sentence(text: string): string {
  return /[.?!…]$/.test(text) ? text : `${text}.`;
}

function shortRun(runId: string): string {
  return runId.length > 8 ? `${runId.slice(0, 8)}…` : runId;
}

function told(
  source: Shown,
  parts: { readonly state: string; readonly detail: unknown },
): string {
  const runId = shortRun(String(source.run["runId"]));
  const title = shown(source.run["title"], source.privateTexts);
  const name = title === "" ? `Run ${runId}` : `Run ${runId} (${title})`;
  const detail = shown(parts.detail, source.privateTexts);
  return detail === ""
    ? `${name} ${parts.state}.`
    : `${name} ${parts.state}: ${sentence(detail)}`;
}

function decisionContent(source: Shown, decision: Fields): string {
  const workflowId = String(source.run["workflowId"]);
  const prompt = operationalDecision(decision, workflowId)["prompt"];
  const [state, answer] = answers[String(decision["type"])] ?? [
    "waits for your decision",
    "Answer with cloving_questions.",
  ];
  return `${told(source, { state, detail: prompt })} ${answer}`;
}

function stopDetail(run: Fields): unknown {
  return run["state"] === "completed"
    ? record(run["outcome"])?.["reason"]
    : record(run["reason"])?.["detail"];
}

function runMeta(
  source: Shown,
  kind: string,
): Readonly<Record<string, string>> {
  const ticket = shown(source.run["ticketId"], source.privateTexts);
  return {
    run_id: String(source.run["runId"]),
    kind,
    workflow: String(source.run["workflowId"]),
    ...(ticket === "" ? {} : { ticket }),
  };
}

function scheduleMessage(workflowId: string, last: string): ChannelMessage {
  return {
    content: `The schedule of ${workflowId} stopped after three failed runs; the last one is ${shortRun(last)}. Resume it with cloving_schedule_resume.`,
    meta: { run_id: last, kind: "schedule_stopped", workflow: workflowId },
  };
}

export function channelMessage(
  alert: Alert,
  privateTexts: readonly string[],
): ChannelMessage {
  if (alert.kind === "schedule-stopped")
    return scheduleMessage(alert.workflowId, String(alert.failedRunIds.at(-1)));
  const source = { run: alert.run, privateTexts };
  if (alert.kind === "decision")
    return {
      content: decisionContent(source, alert.decision),
      meta: {
        ...runMeta(source, alert.kind),
        decision_id: String(alert.decision["decisionId"]),
      },
    };
  const [state, step] = stops[alert.kind] ?? ["stopped", continued];
  return {
    content: `${told(source, { state, detail: stopDetail(alert.run) })} ${step}`,
    meta: runMeta(source, alert.kind),
  };
}
