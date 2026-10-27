import { priceText, usageText, totalsSuffix } from "./usage-render.ts";
import { record, type Fields } from "../protocol.ts";
import { workflowRefusals } from "../workflow-refusals.ts";
import { commandText, shownCommands } from "./command-effects.ts";

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

export function oneLine(value: unknown): string {
  return Array.from(show(value), (character) =>
    hidden(character) ? escaped(character) : character,
  ).join("");
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
  const line = `  ${show(part(run, "runId"))}  ${show(part(run, "workflowId"))}  ${show(part(run, "condition"))}  revision ${show(part(run, "revision"))}  latest at ${show(part(run, "latestAt") ?? "none")}`;
  return [
    line,
    ...ciLines(run).map((notice) => `    ${notice}`),
    ...chainLines(run).map((link) => `    ${link}`),
  ].join("\n");
}

function chainLines(run: unknown): readonly string[] {
  return [
    ...(typeof part(run, "awaitedRunId") === "string"
      ? [`Awaited run: ${visible(part(run, "awaitedRunId"))}`]
      : []),
    `Parent run: ${visible(part(run, "parentRunId") ?? "none")}`,
    `Chain: ${visible(part(run, "chainId") ?? part(run, "runId") ?? "none")}`,
    `Child runs: ${visible(listing(part(run, "childRunIds")))}`,
  ];
}

function ciLines(run: unknown): readonly string[] {
  const reruns = part(run, "ciReruns");
  return (Array.isArray(reruns) ? reruns : []).map(
    (rerun: unknown) =>
      `CI rerun after a failed check: workflow ${visible(part(rerun, "run"))}, commit ${visible(part(rerun, "commit"))}`,
  );
}

function ended(run: Fields): boolean {
  return ["completed", "failed", "cancelled"].includes(show(run["state"]));
}

function newest(first: Fields, second: Fields): number {
  return show(second["latestAt"] ?? "").localeCompare(
    show(first["latestAt"] ?? ""),
  );
}

export function runOverview(result: Fields): Fields {
  const listed = result["runs"];
  const runs: readonly Fields[] = Array.isArray(listed)
    ? listed.map(record).filter((run) => run !== undefined)
    : [];
  const active = runs.filter((run) => !ended(run)).toSorted(newest);
  const finished = runs.filter(ended).toSorted(newest);
  return {
    ...result,
    runs: [...active, ...finished.slice(0, 20)],
    hiddenRuns: Math.max(0, finished.length - 20),
  };
}

function runList(result: Fields): readonly string[] {
  const runs = result["runs"];
  const lines = Array.isArray(runs) ? runs.map(runLine) : [];
  const hiddenRuns = result["hiddenRuns"];
  const refusals = workflowRefusals(result["workflowRefusals"]);
  return [
    `Workflows: ${visible(listing(result["workflows"]))}`,
    ...queueLines(result["queue"]),
    ...(refusals.length === 0
      ? []
      : [
          "Refused workflows:",
          ...refusals.map(
            (entry) =>
              `  ${entry.scope} ${entry.label}: ${entry.codes.join(", ")}`,
          ),
        ]),
    "Runs:",
    ...(lines.length === 0 ? ["  none"] : lines),
    ...(typeof hiddenRuns === "number" && hiddenRuns > 0
      ? [
          `${String(hiddenRuns)} older runs: use --limit and --after to see them`,
        ]
      : []),
  ];
}

export function queueLines(value: unknown): readonly string[] {
  const queue = record(value);
  if (queue === undefined) return [];
  const skipped = queue["skipped"];
  return [
    `Queue: ${visible(queue["busy"])} of ${visible(queue["lanes"])} lanes busy`,
    ...(Array.isArray(skipped)
      ? skipped.map((item: unknown) => {
          const dependencies = part(item, "dependencies");
          const needs = Array.isArray(dependencies)
            ? `; needs ${dependencies.map(visible).join(", ")}`
            : "";
          return `Skipped ticket ${visible(part(item, "ticketId"))}: ${visible(part(item, "reason"))}${needs}`;
        })
      : []),
  ];
}

function observation(value: unknown): string {
  if (record(value) === undefined) return "none";
  return `${show(part(value, "at"))} (sequence ${show(part(value, "sequence"))}, ${show(part(value, "source"))})`;
}

function feedbackLines(value: unknown): readonly string[] {
  return (Array.isArray(value) ? value : []).map(
    (item: unknown) =>
      `Feedback of ${show(part(item, "decisionId"))}: ${visible(part(item, "text"))}`,
  );
}

function outcomeLines(value: unknown): readonly string[] {
  if (record(value) === undefined) return ["Outcome: none"];
  const reason = part(value, "reason");
  const kind = visible(part(value, "kind"));
  return [
    `Outcome: ${typeof reason === "string" ? `${kind}: ${visible(reason)}` : kind}`,
    ...(typeof part(value, "promotionId") === "string"
      ? [`Promotion: ${visible(part(value, "promotionId"))}`]
      : []),
    ...(typeof part(value, "ticketStatus") === "string"
      ? [`Ticket status: ${visible(part(value, "ticketStatus"))}`]
      : []),
    ...(part(value, "issueUpdate") === "failed"
      ? ["Issue status update failed; check the GitHub operation."]
      : []),
  ];
}

function workerLines(value: unknown): readonly string[] {
  return (Array.isArray(value) ? value : []).flatMap((turn: unknown) => [
    `Worker turn ${visible(part(turn, "operationId"))}: ${priceText(part(turn, "costUsd"), part(turn, "estimatedCostUsd"))}`,
    ...(typeof part(turn, "harness") === "string"
      ? [`  Harness: ${visible(part(turn, "harness"))}`]
      : []),
    `  ${usageText(part(turn, "usage"))}`,
    ...(typeof part(turn, "model") === "string"
      ? [`  Model: ${visible(part(turn, "model"))}`]
      : []),
    ...modelLines(part(turn, "attempts")),
    ...(typeof part(turn, "summary") === "string"
      ? [`  Report: ${visible(part(turn, "summary"))}`]
      : []),
  ]);
}

function modelLines(attempts: unknown): readonly string[] {
  if (!Array.isArray(attempts)) return [];
  return attempts.flatMap((attempt: unknown) => {
    const models = part(attempt, "models");
    if (!Array.isArray(models)) return [];
    return models.map(
      (model: unknown) =>
        `  ${visible(part(model, "model"))}: ${usageText(part(model, "usage"))}`,
    );
  });
}

export function statusJson(result: Fields): Fields {
  const run = record(result["run"]);
  if (result["kind"] !== "run-status" || run === undefined) return result;
  const turns = run["workerTurns"];
  return {
    ...result,
    run: {
      ...run,
      costDisplay: priceText(run["claudeCostUsd"], run["estimatedCostUsd"]),
      ...(Array.isArray(turns)
        ? {
            workerTurns: turns.map((turn: unknown) => {
              const fields = record(turn);
              if (fields === undefined) return turn;
              return {
                ...fields,
                costDisplay: priceText(
                  fields["costUsd"],
                  fields["estimatedCostUsd"],
                ),
              };
            }),
          }
        : {}),
    },
  };
}

function inputText(value: unknown): string {
  const text = visible(record(value) ?? null);
  const characters = Array.from(text);
  return characters.length > 200
    ? `${characters.slice(0, 200).join("")}…`
    : text;
}

export function runStatus(result: Fields): readonly string[] {
  const run = result["run"];
  const reason = part(run, "reason");
  const recovery = part(run, "recovery");
  const at = part(run, "nextActionAt") ?? null;
  const suffix = totalsSuffix(part(run, "state"));
  return [
    `Run ${show(part(run, "runId"))} (${show(part(run, "workflowId"))})`,
    `Title: ${visible(part(run, "title") ?? "none")}`,
    `State: ${show(part(run, "state"))}`,
    ...outcomeLines(part(run, "outcome")),
    ...ciLines(run),
    `Condition: ${show(part(run, "condition"))}`,
    `Reason: ${show(part(reason, "code"))}: ${show(part(reason, "detail"))}`,
    `Input: ${inputText(part(run, "input"))}`,
    `Revision: ${show(part(run, "revision"))}, latest sequence ${show(part(run, "latestSequence"))}`,
    `Latest at: ${show(part(run, "latestAt") ?? "none")}`,
    `Pending decisions: ${listing(part(run, "pendingDecisions"))}`,
    `Evidence: ${listing(part(run, "evidence"))}`,
    `Last confirmed observation: ${observation(part(run, "lastConfirmedObservation"))}`,
    `Recovery: ${show(part(recovery, "attempts"))} of ${show(part(recovery, "limit") ?? "no limit")}`,
    `Cost${suffix}: ${priceText(part(run, "claudeCostUsd"), part(run, "estimatedCostUsd"))}`,
    `Token usage${suffix}: ${usageText(part(run, "usage"))}`,
    ...workerLines(part(run, "workerTurns")),
    ...shownCommands(part(run, "commandEffects")).map((effect) =>
      visible(commandText(effect)),
    ),
    `Next action: ${show(part(run, "nextAction") ?? "none")}${at === null ? "" : ` at ${show(at)}`}`,
    `Human input can help: ${part(run, "humanInputCanHelp") === true ? "yes" : "no"}`,
    ...feedbackLines(part(run, "feedback")),
    ...decidedLines(part(run, "decisions")),
    ...chainLines(run),
  ];
}

function decidedLines(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map(
    (decision: unknown) =>
      `Decision ${visible(part(decision, "decisionId"))}: ${visible(part(decision, "decision"))} by ${visible(part(decision, "actor"))}`,
  );
}

function binding(decision: unknown): string {
  return `--expected-revision ${show(part(decision, "revision"))} --generation ${show(part(decision, "generation"))} --subject-digest ${show(part(decision, "subjectDigest"))}`;
}

function suggestion(decision: unknown, command: unknown): string {
  const reference = part(decision, "label") ?? part(decision, "decisionId");
  const head = `  cloving ${show(command)} ${show(reference)}`;
  const tail = binding(decision);
  if (command === "answer") return `${head} --text <answer> ${tail}`;
  if (command === "deny") return `${head} --text "<feedback>" ${tail}`;
  return `${head} ${tail}`;
}

export function decisionLines(decision: unknown): readonly string[] {
  const allowed = part(decision, "allowed");
  const label = part(decision, "label");
  return [
    `${label === null ? "" : `${show(label)} `}${show(part(decision, "type"))} ${show(part(decision, "decisionId"))}`,
    `  Prompt: ${visible(part(decision, "prompt"))}`,
    ...feedbackLines(part(decision, "feedback")).map((line) => `  ${line}`),
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
