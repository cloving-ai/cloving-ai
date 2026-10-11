import { record, type Fields } from "../protocol.ts";

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function escaped(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

const hiddenRanges: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

function hidden(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return hiddenRanges.some(([first, last]) => code >= first && code <= last);
}

function visible(value: unknown): string {
  return show(value)
    .split("\n")
    .map((line) =>
      Array.from(line, (character) =>
        hidden(character) ? escaped(character) : character,
      ).join(""),
    )
    .join("\n    ");
}

export function errorText(error: Fields): string {
  const { candidates } = error;
  const lines = [`${visible(error["code"])}: ${visible(error["detail"])}`];
  if (Array.isArray(candidates))
    lines.push(`Candidates: ${candidates.map(visible).join(", ")}`);
  return lines.map((line) => `${line}\n`).join("");
}

function part(value: unknown, name: string): unknown {
  return record(value)?.[name];
}

function listing(value: unknown): string {
  const items = Array.isArray(value) ? value.map(show) : [];
  return items.length === 0 ? "none" : items.join(", ");
}

function receiptLines(result: Fields): readonly string[] {
  const receipt = result["receipt"];
  return [
    `Command ID: ${show(result["commandId"])}`,
    `Receipt: sequence ${show(part(receipt, "sequence"))}, recorded at ${show(part(receipt, "recordedAt"))}`,
    ...(result["replayed"] === true
      ? ["This is the receipt of the earlier equal command."]
      : []),
  ];
}

function admitted(result: Fields): readonly string[] {
  return [
    `Run ${show(result["runId"])} is admitted.`,
    ...receiptLines(result),
    "The run is queued. Admission is not completed work.",
  ];
}

function runLine(run: unknown): string {
  return `  ${show(part(run, "runId"))}  ${show(part(run, "workflowId"))}  ${show(part(run, "condition"))}  revision ${show(part(run, "revision"))}`;
}

function runList(result: Fields): readonly string[] {
  const runs = result["runs"];
  const lines = Array.isArray(runs) ? runs.map(runLine) : [];
  return ["Runs:", ...(lines.length === 0 ? ["  none"] : lines)];
}

function observation(value: unknown): string {
  if (record(value) === undefined) return "none";
  return `${show(part(value, "at"))} (sequence ${show(part(value, "sequence"))}, ${show(part(value, "source"))})`;
}

function runStatus(result: Fields): readonly string[] {
  const run = result["run"];
  const reason = part(run, "reason");
  const recovery = part(run, "recovery");
  const at = part(run, "nextActionAt") ?? null;
  return [
    `Run ${show(part(run, "runId"))} (${show(part(run, "workflowId"))})`,
    `State: ${show(part(run, "state"))}`,
    `Condition: ${show(part(run, "condition"))}`,
    `Reason: ${show(part(reason, "code"))}: ${show(part(reason, "detail"))}`,
    `Revision: ${show(part(run, "revision"))}, latest sequence ${show(part(run, "latestSequence"))}`,
    `Pending decisions: ${listing(part(run, "pendingDecisions"))}`,
    `Evidence: ${listing(part(run, "evidence"))}`,
    `Last confirmed observation: ${observation(part(run, "lastConfirmedObservation"))}`,
    `Recovery: ${show(part(recovery, "attempts"))} of ${show(part(recovery, "limit") ?? "no limit")}`,
    `Next action: ${show(part(run, "nextAction") ?? "none")}${at === null ? "" : ` at ${show(at)}`}`,
    `Human input can help: ${part(run, "humanInputCanHelp") === true ? "yes" : "no"}`,
  ];
}

function binding(decision: unknown): string {
  return `--expected-revision ${show(part(decision, "revision"))} --generation ${show(part(decision, "generation"))} --subject-digest ${show(part(decision, "subjectDigest"))}`;
}

function suggestion(decision: unknown, command: unknown): string {
  const reference = part(decision, "label") ?? part(decision, "decisionId");
  const text = command === "answer" ? " --text <answer>" : "";
  return `  cloving ${show(command)} ${show(reference)}${text} ${binding(decision)}`;
}

function decisionLines(decision: unknown): readonly string[] {
  const allowed = part(decision, "allowed");
  const label = part(decision, "label");
  return [
    `${label === null ? "" : `${show(label)} `}${show(part(decision, "type"))} ${show(part(decision, "decisionId"))}`,
    `  Prompt: ${visible(part(decision, "prompt"))}`,
    ...(Array.isArray(allowed) ? allowed : []).map((command: unknown) =>
      suggestion(decision, command),
    ),
  ];
}

export function decisionList(result: Fields): readonly string[] {
  const decisions = result["decisions"];
  const lines = Array.isArray(decisions)
    ? decisions.flatMap(decisionLines)
    : [];
  return lines.length === 0 ? ["No decision waits."] : lines;
}

function decisionRecorded(result: Fields): readonly string[] {
  const run = result["run"];
  return [
    `Decision ${show(result["decisionId"])} is recorded as ${show(result["decision"])}.`,
    ...receiptLines(result),
    `Run state: ${show(part(run, "state"))}, revision ${show(part(run, "revision"))}`,
    `Continuation: ${show(result["continuation"])}`,
  ];
}

function runCommand(result: Fields): readonly string[] {
  const committed = result["committed"];
  const observed = result["observed"];
  return [
    `Run ${show(result["runId"])}: ${show(result["command"])} is committed. State ${show(part(committed, "state"))}, revision ${show(part(committed, "revision"))}.`,
    ...receiptLines(result),
    `Revoked intents: ${show(part(committed, "revokedIntents"))}`,
    `Observed: ${show(part(observed, "condition"))}`,
    `Unresolved effects: ${listing(part(observed, "unresolvedEffects"))}`,
  ];
}

export function eventText(event: Fields): string {
  return `${show(event["sequence"])}  ${show(event["recordedAt"])}  ${show(event["type"])}  ${show(event["runId"])}  ${JSON.stringify(event["payload"])}`;
}

function eventPage(result: Fields): readonly string[] {
  const events = result["events"];
  return (Array.isArray(events) ? events : []).map((event: unknown) =>
    eventText(record(event) ?? {}),
  );
}

const renderers = new Map<string, (result: Fields) => readonly string[]>([
  ["run-admitted", admitted],
  ["run-list", runList],
  ["run-status", runStatus],
  ["decision-list", decisionList],
  ["decision-recorded", decisionRecorded],
  ["run-command", runCommand],
  ["event-page", eventPage],
]);

export function rendered(result: Fields): string {
  const lines = renderers.get(show(result["kind"]))?.(result) ?? [];
  return lines.map((line) => `${line}\n`).join("");
}

export function pendingSummary(result: Fields): string {
  const decisions = result["decisions"];
  const lines = (Array.isArray(decisions) ? decisions : []).map(
    (decision: unknown) =>
      `  ${show(part(decision, "label") ?? part(decision, "type"))} ${show(part(decision, "decisionId"))}: ${visible(part(decision, "prompt"))}`,
  );
  return ["Pending decisions:", ...(lines.length === 0 ? ["  none"] : lines)]
    .map((line) => `${line}\n`)
    .join("");
}
