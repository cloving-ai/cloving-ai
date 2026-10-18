export interface Omissions {
  metadataRecords: number;
  thinkingBlocks: number;
}

export interface MessageRecord {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly role: "user" | "assistant";
  readonly timestamp: string | null;
  readonly sessionId: string | null;
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

export interface NormalizedTranscript {
  readonly status: "included" | "unsupported";
  readonly reason: string;
  readonly records: readonly MessageRecord[];
  readonly omissions: Omissions;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportedBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const type = block["type"];
  if (type === "text" && typeof block["text"] === "string")
    return { type, text: block["text"] };
  if (
    type === "tool_use" &&
    typeof block["id"] === "string" &&
    typeof block["name"] === "string" &&
    Object.hasOwn(block, "input")
  ) {
    return {
      type,
      id: block["id"],
      name: block["name"],
      input: block["input"],
    };
  }
  if (type === "tool_result") return toolResult(block);
  throw new Error("unsupported-block");
}

function toolResult(block: Record<string, unknown>): Record<string, unknown> {
  if (
    typeof block["tool_use_id"] !== "string" ||
    !Object.hasOwn(block, "content")
  )
    throw new Error("unsupported-block");
  if (
    Object.hasOwn(block, "is_error") &&
    typeof block["is_error"] !== "boolean"
  )
    throw new Error("unsupported-block");
  return {
    type: "tool_result",
    tool_use_id: block["tool_use_id"],
    content: block["content"],
    ...(Object.hasOwn(block, "is_error")
      ? { is_error: block["is_error"] }
      : {}),
  };
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("unsupported-message");
  return value;
}

function rawJsonApi(
  value: object,
): value is { rawJSON: (text: string) => unknown } {
  return "rawJSON" in value && typeof value.rawJSON === "function";
}

function preserveJson(...argumentsList: readonly unknown[]): unknown {
  const [, value, context] = argumentsList;
  if (typeof value !== "number") return value;
  if (!object(context) || typeof context["source"] !== "string")
    throw new Error("unsupported-record");
  if (JSON.stringify(value) === context["source"]) return value;
  if (!rawJsonApi(JSON)) throw new Error("unsupported-record");
  return JSON.rawJSON(context["source"]);
}

export function parsePreservedJson(text: string): unknown {
  return JSON.parse(text, preserveJson);
}

function blocks(
  content: unknown,
  omissions: Omissions,
): Record<string, unknown>[] {
  if (typeof content === "string")
    return [{ position: 0, type: "text", text: content }];
  if (!Array.isArray(content)) throw new Error("unsupported-message");
  return content.flatMap((block: unknown, position) => {
    if (!object(block)) throw new Error("unsupported-block");
    if (block["type"] === "thinking") {
      omissions.thinkingBlocks++;
      return [];
    }
    return [{ ...supportedBlock(block), position }];
  });
}

function message(
  value: unknown,
  context: { sourceId: string; omissions: Omissions },
): MessageRecord | null {
  if (!object(value) || typeof value["type"] !== "string")
    throw new Error("unsupported-record");
  if (
    value["type"] !== "user" &&
    value["type"] !== "assistant" &&
    Object.hasOwn(value, "message")
  )
    throw new Error("unsupported-message");
  if (value["type"] !== "user" && value["type"] !== "assistant") {
    context.omissions.metadataRecords++;
    return null;
  }
  const envelope = value["message"];
  if (!object(envelope) || envelope["role"] !== value["type"])
    throw new Error("unsupported-message");
  const normalized = blocks(envelope["content"], context.omissions);
  return {
    schemaVersion: 1,
    sourceId: context.sourceId,
    role: value["type"],
    timestamp: optionalText(value["timestamp"]),
    sessionId: optionalText(value["sessionId"]),
    text: normalized
      .filter((block) => block["type"] === "text")
      .map((block) => block["text"])
      .join("\n"),
    blocks: normalized,
  };
}

export function normalizeTranscript(
  text: string,
  digest: string,
): NormalizedTranscript {
  const omissions = { metadataRecords: 0, thinkingBlocks: 0 };
  const records: MessageRecord[] = [];
  if (text === "")
    return { status: "unsupported", reason: "empty-file", records, omissions };
  let offset = 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  try {
    for (const line of lines) {
      const parsed: unknown = parsePreservedJson(line);
      const record = message(parsed, {
        sourceId: `${digest}:${String(offset)}`,
        omissions,
      });
      if (record !== null) records.push(record);
      offset += new TextEncoder().encode(line).length + 1;
    }
  } catch (error) {
    let reason = "unsupported-record";
    if (error instanceof Error) reason = error.message;
    if (error instanceof SyntaxError) reason = "invalid-json";
    return {
      status: "unsupported",
      reason,
      records: [],
      omissions,
    };
  }
  return { status: "included", reason: "supported", records, omissions };
}
