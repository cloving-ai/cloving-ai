import { record, type Fields } from "../protocol.ts";
import { piResponse } from "../pi-usage.ts";
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

function validPart(value: unknown): boolean {
  const part = record(value) ?? {};
  switch (part["type"]) {
    case "text":
      return typeof part["text"] === "string";
    case "thinking":
      return typeof part["thinking"] === "string" || part["redacted"] === true;
    case "toolCall":
      return (
        typeof part["id"] === "string" &&
        typeof part["name"] === "string" &&
        record(part["arguments"]) !== undefined
      );
    default:
      return false;
  }
}

export function piMessageFailure(event: Fields): string | undefined {
  if (event["type"] !== "message_end") return undefined;
  const message = record(event["message"]);
  if (message === undefined || typeof message["role"] !== "string")
    return "Pi malformed message_end record";
  if (message["role"] === "toolResult" && !validPiToolResult(message))
    return "Pi malformed toolResult message_end record";
  if (message["role"] !== "assistant") return undefined;
  const content = message["content"];
  const reasons = ["stop", "length", "toolUse", "error", "aborted", "deferred"];
  return Array.isArray(content) &&
    content.every(validPart) &&
    reasons.includes(String(message["stopReason"]))
    ? undefined
    : "Pi malformed assistant record";
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

export function responseIdentity(message: Fields): string | undefined {
  const response = piResponse(message);
  if (response.responseId !== null)
    return JSON.stringify([
      response.provider,
      response.model,
      response.responseId,
    ]);
  const timestamp = message["timestamp"];
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    return undefined;
  return JSON.stringify([
    response,
    timestamp,
    message["content"],
    message["stopReason"],
    message["errorMessage"],
    message["api"],
    message["thinkingLevel"],
  ]);
}

export function responseAnchor(message: Fields): string | undefined {
  const response = piResponse(message);
  if (response.responseId !== null)
    return JSON.stringify([
      response.provider,
      response.model,
      response.responseId,
    ]);
  if (typeof message["timestamp"] !== "number") return undefined;
  return JSON.stringify([
    response.provider,
    response.model,
    message["timestamp"],
  ]);
}

export function piSessionHeader(identity?: {
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: string;
}): string | null {
  return identity === undefined
    ? null
    : JSON.stringify([identity.id, identity.cwd, identity.timestamp]);
}
