import { record, type Fields } from "../protocol.ts";
import { tokenCount } from "../worker-usage.ts";

function update(event: Fields): boolean {
  const update = record(event["assistantMessageEvent"]);
  if (update === undefined || typeof update["type"] !== "string") return false;
  const type = update["type"];
  if (["start", "done", "error"].includes(type)) return true;
  if (tokenCount(update["contentIndex"]) === null) return false;
  if (type.endsWith("_delta")) return typeof update["delta"] === "string";
  if (["text_end", "thinking_end"].includes(type))
    return typeof update["content"] === "string";
  if (type === "toolcall_end") return record(update["toolCall"]) !== undefined;
  return ["text_start", "thinking_start", "toolcall_start"].includes(type);
}

export function validPiActivity(event: Fields): boolean {
  switch (event["type"]) {
    case "message_start":
      return typeof record(event["message"])?.["role"] === "string";
    case "message_update":
      return update(event);
    case "tool_execution_start":
      return toolStart(event);
    case "tool_execution_update":
      return (
        toolStart(event) &&
        validPiToolResult({
          ...record(event["partialResult"]),
          toolCallId: event["toolCallId"],
          toolName: event["toolName"],
          isError: false,
        })
      );
    case "tool_execution_end":
      return toolEnd(event);
    default:
      return true;
  }
}

export const piWorkEvents: ReadonlySet<string> = new Set([
  "agent_start",
  "turn_start",
  "auto_retry_start",
  "compaction_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

function toolStart(event: Fields): boolean {
  return (
    typeof event["toolCallId"] === "string" &&
    typeof event["toolName"] === "string" &&
    record(event["args"]) !== undefined
  );
}

function toolEnd(event: Fields): boolean {
  return validPiToolResult({
    ...record(event["result"]),
    toolCallId: event["toolCallId"],
    toolName: event["toolName"],
    isError: event["isError"],
  });
}

export function validPiToolResult(message: Fields): boolean {
  const content = message["content"];
  return (
    typeof message["toolCallId"] === "string" &&
    message["toolCallId"] !== "" &&
    typeof message["toolName"] === "string" &&
    typeof message["isError"] === "boolean" &&
    Array.isArray(content) &&
    content.every((value: unknown) => {
      const part = record(value);
      return part?.["type"] === "text"
        ? typeof part["text"] === "string"
        : part?.["type"] === "image" &&
            typeof part["data"] === "string" &&
            typeof part["mimeType"] === "string";
    })
  );
}
