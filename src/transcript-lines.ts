export type TranscriptKind =
  | "prompt"
  | "assistant"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "notice"
  | "result";

export interface TranscriptDraft {
  readonly kind: TranscriptKind;
  readonly text: string;
  readonly tool?: string;
  readonly summary?: string;
  readonly error?: boolean;
  readonly callId?: string;
}

type Fields = Readonly<Record<string, unknown>>;
type Drafts = readonly TranscriptDraft[];
type Mapping = (line: Fields) => Drafts | undefined;

const summaryFields = [
  "command",
  "file_path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
];

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value }
    : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shown(value: unknown): string {
  return typeof value === "number" ? String(value) : text(value);
}

function parsed(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    return undefined;
  }
}

function joined(parts: readonly unknown[], separator: string): string {
  return parts
    .map(shown)
    .filter((part) => part !== "")
    .join(separator);
}

const none = (): Drafts => [];

function notice(words: string): Drafts {
  return [{ kind: "notice", text: words }];
}

function said(kind: TranscriptKind, value: unknown): Drafts {
  const words = text(value);
  return words.trim() === "" ? [] : [{ kind, text: words }];
}

function inputSummary(input: unknown): string {
  if (typeof input === "string") return input;
  const fields = record(input);
  const named = summaryFields
    .map((name) => text(fields[name]))
    .find((value) => value !== "");
  return named ?? JSON.stringify(input ?? {});
}

function toolCall(part: Fields): TranscriptDraft {
  const input = part["input"];
  return {
    kind: "tool-call",
    tool: text(part["name"]),
    callId: text(part["id"]),
    summary: inputSummary(input),
    text:
      typeof input === "string" ? input : JSON.stringify(input ?? {}, null, 2),
  };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return list(content)
    .map(record)
    .map((item) =>
      item["type"] === "text"
        ? text(item["text"])
        : `[${text(item["type"]) || "content"}]`,
    )
    .join("\n");
}

const assistantParts = new Map<string, (part: Fields) => Drafts>([
  ["text", (part) => said("assistant", part["text"])],
  ["thinking", (part) => said("thinking", part["thinking"])],
  ["redacted_thinking", none],
  ["tool_use", (part) => [toolCall(part)]],
]);

const userParts = new Map<string, (part: Fields) => Drafts>([
  [
    "tool_result",
    (part) => [
      {
        kind: "tool-result",
        text: resultText(part["content"]),
        error: part["is_error"] === true,
        callId: text(part["tool_use_id"]),
      },
    ],
  ],
  ["text", (part) => said("notice", part["text"])],
]);

function messageParts(
  line: Fields,
  parts: ReadonlyMap<string, (part: Fields) => Drafts>,
): Drafts {
  const content = record(line["message"])["content"];
  if (typeof content === "string") return said("notice", content);
  return list(content)
    .map(record)
    .flatMap(
      (part) =>
        parts.get(text(part["type"]))?.(part) ?? notice(JSON.stringify(part)),
    );
}

function taskStarted(line: Fields): Drafts {
  const task = line["is_backgrounded"] === true ? "Background task" : "Task";
  return notice(`${task} started: ${text(line["description"])}`);
}

function retried(line: Fields): Drafts {
  const cause = joined([line["error_status"], line["error"]], " ");
  return notice(
    `API retry ${shown(line["attempt"])} of ${shown(line["max_retries"])}: ${cause}`,
  );
}

function sessionStarted(line: Fields): Drafts {
  const model = text(line["model"]);
  return notice(joined(["Session started", model && `model ${model}`], " · "));
}

const quietEvents = [
  "thinking_tokens",
  "task_progress",
  "task_updated",
  "background_tasks_changed",
  "hook_started",
  "vcs_state_changed",
];

const systemEvents = new Map<string, Mapping>([
  ["init", sessionStarted],
  ["task_started", taskStarted],
  [
    "task_notification",
    (line) => notice(`Task ${text(line["status"])}: ${text(line["summary"])}`),
  ],
  ["api_retry", retried],
  ["compact_boundary", () => notice("Context compacted")],
  [
    "hook_response",
    (line) =>
      notice(`Hook ${text(line["hook_name"])}: ${text(line["outcome"])}`),
  ],
  ...quietEvents.map((name): [string, Mapping] => [name, none]),
]);

function rateLimit(line: Fields): Drafts {
  const info = record(line["rate_limit_info"]);
  if (info["status"] === "allowed") return [];
  return notice(
    `Rate limit ${text(info["rateLimitType"])}: ${text(info["status"])}`,
  );
}

function costText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `cost ${value.toFixed(2)} USD`
    : "cost unknown";
}

function turnsText(value: unknown): string {
  if (typeof value !== "number") return "";
  return value === 1 ? "1 turn" : `${String(value)} turns`;
}

function turnEnd(
  outcome: string,
  detail: { readonly facts: readonly string[]; readonly error: string },
): Drafts {
  const summary = joined([`Turn end: ${outcome}`, ...detail.facts], " · ");
  return [
    {
      kind: "result",
      text: joined([summary, detail.error], "\n"),
      error: detail.error !== "",
    },
  ];
}

function claudeResult(line: Fields): Drafts {
  const stop = text(line["stop_reason"]);
  return turnEnd(text(line["subtype"]), {
    facts: [
      costText(line["total_cost_usd"]),
      turnsText(line["num_turns"]),
      stop === "" ? "" : `stop reason ${stop}`,
    ],
    error: line["is_error"] === true ? text(line["result"]) || "error" : "",
  });
}

const lineTypes = new Map<string, Mapping>([
  ["assistant", (line) => messageParts(line, assistantParts)],
  ["user", (line) => messageParts(line, userParts)],
  ["system", (line) => systemEvents.get(text(line["subtype"]))?.(line)],
  ["result", claudeResult],
  ["rate_limit_event", rateLimit],
  ["tool_progress", none],
  ["command_lifecycle", none],
  ["stream_event", none],
]);

export function lineDrafts(line: string): Drafts {
  const fields = record(parsed(line));
  return lineTypes.get(text(fields["type"]))?.(fields) ?? notice(line);
}
