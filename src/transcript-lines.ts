export type TranscriptKind =
  "assistant" | "thinking" | "tool-call" | "tool-result" | "notice" | "result";

export interface TranscriptDraft {
  readonly kind: TranscriptKind;
  readonly text: string;
  readonly tool?: string;
  readonly summary?: string;
  readonly error?: boolean;
}

type Fields = Readonly<Record<string, unknown>>;
type Drafts = readonly TranscriptDraft[];
type Mapping = (line: Fields) => Drafts | undefined;

const summaryLimit = 200;
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

function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > summaryLimit
    ? `${line.slice(0, summaryLimit - 1)}…`
    : line;
}

function inputSummary(input: unknown): string {
  if (typeof input === "string") return oneLine(input);
  const fields = record(input);
  const named = summaryFields
    .map((name) => text(fields[name]))
    .find((value) => value !== "");
  return oneLine(named ?? JSON.stringify(input ?? {}));
}

function toolCall(tool: string, input: unknown): TranscriptDraft {
  return {
    kind: "tool-call",
    tool,
    summary: `${tool}: ${inputSummary(input)}`,
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
  ["tool_use", (part) => [toolCall(text(part["name"]), part["input"])]],
]);

const userParts = new Map<string, (part: Fields) => Drafts>([
  [
    "tool_result",
    (part) => [
      {
        kind: "tool-result",
        text: resultText(part["content"]),
        error: part["is_error"] === true,
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

const quietEvents = [
  "thinking_tokens",
  "task_progress",
  "task_updated",
  "background_tasks_changed",
  "hook_started",
  "vcs_state_changed",
];

const systemEvents = new Map<string, Mapping>([
  ["init", (line) => notice(`Session started · model ${text(line["model"])}`)],
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

const codexStarts = new Map<string, (item: Fields) => Drafts>([
  ["command_execution", (item) => [toolCall("shell", text(item["command"]))]],
  [
    "mcp_tool_call",
    (item) => [
      toolCall(
        joined([item["server"], item["tool"]], "."),
        item["arguments"] ?? {},
      ),
    ],
  ],
]);

function commandFailed(item: Fields): boolean {
  const code = item["exit_code"];
  return (
    item["status"] === "failed" || (typeof code === "number" && code !== 0)
  );
}

function changedFiles(item: Fields): Drafts {
  const paths = list(item["changes"]).map((change) =>
    text(record(change)["path"]),
  );
  return [toolCall("apply_patch", { file_path: paths.join(" ") })];
}

function toolOutput(item: Fields): Drafts {
  const failure = item["error"];
  return [
    {
      kind: "tool-result",
      text: JSON.stringify(failure ?? item["result"] ?? null, null, 2),
      error: failure !== undefined && failure !== null,
    },
  ];
}

const codexEnds = new Map<string, (item: Fields) => Drafts>([
  ["agent_message", (item) => said("assistant", item["text"])],
  ["reasoning", (item) => said("thinking", item["text"])],
  [
    "command_execution",
    (item) => [
      {
        kind: "tool-result",
        text: text(item["aggregated_output"]),
        error: commandFailed(item),
      },
    ],
  ],
  ["file_change", changedFiles],
  ["mcp_tool_call", toolOutput],
]);

const lineTypes = new Map<string, Mapping>([
  ["assistant", (line) => messageParts(line, assistantParts)],
  ["user", (line) => messageParts(line, userParts)],
  ["system", (line) => systemEvents.get(text(line["subtype"]))?.(line)],
  ["result", claudeResult],
  ["rate_limit_event", rateLimit],
  ["tool_progress", none],
  ["command_lifecycle", none],
  ["stream_event", none],
  ["thread.started", () => notice("Session started")],
  ["turn.started", none],
  [
    "turn.completed",
    () => turnEnd("completed", { facts: [costText(null)], error: "" }),
  ],
  [
    "turn.failed",
    (line) =>
      turnEnd("failed", {
        facts: [costText(null)],
        error: text(record(line["error"])["message"]) || "error",
      }),
  ],
  ["error", (line) => notice(`Error: ${text(line["message"])}`)],
  [
    "item.started",
    (line) => {
      const item = record(line["item"]);
      return codexStarts.get(text(item["type"]))?.(item) ?? [];
    },
  ],
  ["item.updated", none],
  [
    "item.completed",
    (line) => {
      const item = record(line["item"]);
      return codexEnds.get(text(item["type"]))?.(item);
    },
  ],
]);

export function lineDrafts(line: string): Drafts {
  const fields = record(parsed(line));
  return lineTypes.get(text(fields["type"]))?.(fields) ?? notice(line);
}
