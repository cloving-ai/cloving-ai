import { record, type Fields } from "../protocol.ts";
import { tokenCount, usageOf, type WorkerUsage } from "../worker-usage.ts";

interface CursorState {
  model: string | null;
  sessionId: string | null;
  report: string;
  error: string | null;
  terminal: Fields | undefined;
  toolCalls: Set<string>;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cursorUsage(value: unknown): WorkerUsage {
  const fields = record(value);
  const counts = {
    input_tokens: tokenCount(fields?.["inputTokens"]),
    cache_read_input_tokens: tokenCount(fields?.["cacheReadTokens"]),
    cache_creation_input_tokens: tokenCount(fields?.["cacheWriteTokens"]),
    output_tokens: tokenCount(fields?.["outputTokens"]),
  };
  return Object.values(counts).includes(null) ? usageOf(null) : counts;
}

function received(event: Fields, state: CursorState): void {
  const type = event["type"];
  if (type === "system" || type === "result") {
    state.model = text(event["model"]) ?? state.model;
    state.sessionId = text(event["session_id"]) ?? state.sessionId;
  }
  if (type === "assistant") state.report = assistantText(event) ?? state.report;
  if (type === "error")
    state.error = text(event["message"]) ?? "cursor-agent stream error";
  if (type === "result") state.terminal = event;
}

function assistantText(event: Fields): string | null {
  const content = record(event["message"])?.["content"];
  if (!Array.isArray(content)) return null;
  const blocks = content
    .map((block: unknown) => record(block))
    .filter((block) => block?.["type"] === "text");
  if (blocks.length === 0) return null;
  return blocks.map((block) => text(block?.["text"]) ?? "").join("");
}

function toolCall(
  key: string,
  value: unknown,
): { name: string; input: Fields } | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  if (key === "function") {
    const name = text(fields["name"]);
    if (!name) return undefined;
    try {
      const input = record(JSON.parse(String(fields["arguments"])));
      return input === undefined ? undefined : { name, input };
    } catch {
      return undefined;
    }
  }
  if (!key.endsWith("ToolCall")) return undefined;
  const args = record(fields["args"]);
  if (args === undefined) return undefined;
  return {
    name:
      key === "shellToolCall"
        ? "Bash"
        : key.slice(0, 1).toUpperCase() + key.slice(1, -8),
    input: { ...args, file_path: args["path"] },
  };
}

function toolActivity(event: Fields, state: CursorState): string[] {
  if (!["started", "completed"].includes(String(event["subtype"]))) return [];
  const callId = text(event["call_id"]);
  if (callId !== null && state.toolCalls.has(callId)) return [];
  const tools = record(event["tool_call"]) ?? {};
  const messages = Object.entries(tools).flatMap(([key, value]) => {
    const tool = toolCall(key, value);
    if (tool === undefined) return [];
    return [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: callId,
              ...tool,
            },
          ],
        },
      }),
    ];
  });
  if (callId !== null && messages.length > 0) state.toolCalls.add(callId);
  return messages;
}

function failure(state: CursorState, exitCode: number | null): string | null {
  if (state.error !== null) return state.error;
  if (exitCode !== 0)
    return `cursor-agent ended with the code ${String(exitCode)}`;
  const terminal = state.terminal;
  if (terminal === undefined)
    return "cursor-agent stream ended before its result";
  if (terminal["subtype"] === "success" && terminal["is_error"] === false)
    return null;
  return text(terminal["result"]) ?? "cursor-agent result did not succeed";
}

function result(state: CursorState, exitCode: number | null): string {
  const error = failure(state, exitCode);
  const success = error === null;
  return JSON.stringify({
    type: "result",
    subtype: success ? "success" : "error_during_execution",
    is_error: !success,
    result: error ?? state.report,
    model: state.model,
    session_id: state.sessionId,
    usage: cursorUsage(state.terminal?.["usage"]),
  });
}

export function cursorStream(): {
  readonly line: (line: string) => readonly string[];
  readonly result: (exitCode: number | null) => string;
} {
  const state: CursorState = {
    model: null,
    sessionId: null,
    report: "",
    error: null,
    terminal: undefined,
    toolCalls: new Set(),
  };
  return {
    line: (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return [];
      }
      const event = record(value) ?? {};
      received(event, state);
      if (event["type"] === "tool_call") return toolActivity(event, state);
      return event["type"] === "result" ? [] : [line];
    },
    result: (exitCode) => result(state, exitCode),
  };
}
