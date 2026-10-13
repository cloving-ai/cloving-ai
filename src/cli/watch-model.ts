import type {
  WatchDecision,
  WatchEvent,
  WatchItem,
  WatchModel,
  WatchRun,
  WatchTurn,
} from "./watch-render.ts";

type Fields = Readonly<Record<string, unknown>>;

const textLimit = 600;
const activityLimit = 400;

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function parsed(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    return undefined;
  }
}

function cut(value: string): string {
  return value.length > textLimit ? `${value.slice(0, textLimit)}…` : value;
}

function summary(input: Fields): string {
  const named = ["command", "file_path", "pattern", "description"]
    .map((name) => text(input[name]))
    .find((value) => value !== "");
  return named ?? JSON.stringify(input);
}

function said(part: Fields): WatchItem[] {
  if (part["type"] === "text")
    return [{ kind: "say", text: cut(text(part["text"])) }];
  if (part["type"] !== "tool_use") return [];
  const tool = `${text(part["name"])}: ${summary(record(part["input"]))}`;
  return [{ kind: "tool", text: cut(tool) }];
}

function failed(part: Fields): WatchItem[] {
  if (part["type"] !== "tool_result" || part["is_error"] !== true) return [];
  const content = part["content"];
  const shown = typeof content === "string" ? content : JSON.stringify(content);
  return [{ kind: "error", text: cut(shown) }];
}

function ended(line: Fields): WatchItem[] {
  const cost = count(line["total_cost_usd"]);
  const spent = cost === null ? "" : ` (cost ${cost.toFixed(2)} USD)`;
  return [{ kind: "result", text: `${cut(text(line["result"]))}${spent}` }];
}

function parts(line: Fields): readonly Fields[] {
  return list(record(line["message"])["content"]).map(record);
}

export function activityOf(line: string): WatchItem[] {
  const value = record(parsed(line));
  if (value["type"] === "assistant") return parts(value).flatMap(said);
  if (value["type"] === "user") return parts(value).flatMap(failed);
  return value["type"] === "result" ? ended(value) : [];
}

function costOf(lines: readonly string[]): number | null {
  const costs = lines
    .map((line) => record(parsed(line)))
    .filter((value) => value["type"] === "result")
    .map((value) => count(value["total_cost_usd"]));
  return costs.at(-1) ?? null;
}

export interface TurnRecords {
  readonly key: string;
  readonly started: unknown;
  readonly result: unknown;
  readonly lines: readonly string[];
}

export function turnOf(records: TurnRecords): WatchTurn {
  const started = record(records.started);
  const operation = list(parsed(text(started["operationId"])));
  const outcome = text(record(records.result)["outcome"]);
  return {
    key: records.key,
    runId: text(operation[2]),
    target: text(started["target"]),
    branch: text(started["branch"]),
    worktree: text(started["worktree"]),
    startedAt: text(started["startedAt"]),
    outcome: records.result === null ? "in work" : outcome,
    costUsd: costOf(records.lines),
    activity: records.lines.flatMap(activityOf).slice(-activityLimit),
  };
}

export function decisionCommands(
  decision: unknown,
  client: string,
): WatchDecision {
  const fields = record(decision);
  const decisionId = text(fields["decisionId"]);
  const binding = `${decisionId} --expected-revision ${String(fields["revision"])} --generation ${String(fields["generation"])} --subject-digest ${text(fields["subjectDigest"])}`;
  return {
    decisionId,
    type: text(fields["type"]),
    prompt: text(fields["prompt"]),
    approve: `${client} approve ${binding}`,
    deny: `${client} deny ${binding}`,
  };
}

export interface WatchInputs {
  readonly host: string;
  readonly client: string;
  readonly updatedAt: string;
  readonly service: string;
  readonly runs: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly turns: readonly WatchTurn[];
}

function eventOf(value: unknown): WatchEvent {
  const fields = record(value);
  return {
    sequence: count(fields["sequence"]) ?? 0,
    recordedAt: text(fields["recordedAt"]),
    type: text(fields["type"]),
  };
}

function runOf(inputs: WatchInputs, value: unknown): WatchRun {
  const status = record(record(value)["status"]);
  const runId = text(status["runId"]);
  const budget = record(status["budget"]);
  return {
    runId,
    workflowId: text(status["workflowId"]),
    state: text(status["state"]),
    code: text(record(status["reason"])["code"]),
    detail: text(record(status["reason"])["detail"]),
    spent: count(budget["spent"]),
    limit: count(budget["limit"]),
    decisions: inputs.decisions
      .filter((decision) => record(decision)["runId"] === runId)
      .map((decision) => decisionCommands(decision, inputs.client)),
    events: list(record(value)["events"]).map(eventOf),
    turns: inputs.turns.filter((turn) => turn.runId === runId),
  };
}

function began(run: WatchRun): string {
  return run.events[0]?.recordedAt ?? "";
}

export function watchModel(inputs: WatchInputs): WatchModel {
  return {
    updatedAt: inputs.updatedAt,
    host: inputs.host,
    service: inputs.service,
    runs: inputs.runs
      .map((value) => runOf(inputs, value))
      .toSorted((first, second) => (began(first) < began(second) ? 1 : -1)),
  };
}
