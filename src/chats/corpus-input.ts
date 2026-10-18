import { parsePreservedJson, type MessageRecord } from "./normalize.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(
  value: Record<string, unknown>,
  fields: {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
  },
): boolean {
  const { required, optional = [] } = fields;
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function block(value: unknown): value is Record<string, unknown> {
  if (!object(value) || !natural(value["position"])) return false;
  if (value["type"] === "text")
    return (
      keys(value, { required: ["type", "position", "text"] }) &&
      typeof value["text"] === "string"
    );
  if (value["type"] === "tool_use")
    return (
      keys(value, { required: ["type", "position", "id", "name", "input"] }) &&
      typeof value["id"] === "string" &&
      typeof value["name"] === "string"
    );
  if (value["type"] !== "tool_result") return false;
  return toolResult(value);
}

function toolResult(value: Record<string, unknown>): boolean {
  return (
    keys(value, {
      required: ["type", "position", "tool_use_id", "content"],
      optional: ["is_error"],
    }) &&
    typeof value["tool_use_id"] === "string" &&
    (!Object.hasOwn(value, "is_error") ||
      typeof value["is_error"] === "boolean")
  );
}

function messageFields(value: Record<string, unknown>): boolean {
  return (
    keys(value, {
      required: [
        "schemaVersion",
        "sourceId",
        "role",
        "timestamp",
        "sessionId",
        "text",
        "blocks",
      ],
    }) &&
    value["schemaVersion"] === 1 &&
    typeof value["sourceId"] === "string" &&
    value["sourceId"] !== "" &&
    ["user", "assistant"].includes(String(value["role"])) &&
    optionalText(value["timestamp"]) &&
    optionalText(value["sessionId"]) &&
    typeof value["text"] === "string"
  );
}

function message(value: unknown): value is MessageRecord {
  if (!object(value) || !messageFields(value)) return false;
  if (!Array.isArray(value["blocks"]) || !value["blocks"].every(block))
    return false;
  let position = -1;
  for (const item of value["blocks"]) {
    const next = item["position"];
    if (!natural(next) || next <= position) return false;
    position = next;
  }
  return true;
}

export function parseCorpus(text: string): readonly MessageRecord[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => {
    const value = parsePreservedJson(line);
    if (!message(value)) throw new Error("invalid-import");
    return value;
  });
}

function coverageFile(value: unknown): boolean {
  if (
    !object(value) ||
    typeof value["path"] !== "string" ||
    typeof value["reason"] !== "string"
  )
    return false;
  if (
    !["included", "unreadable", "unsupported", "too-large"].includes(
      String(value["status"]),
    )
  )
    return false;
  if (!optionalText(value["digest"]) || !natural(value["recordCount"]))
    return false;
  const omissions = value["omissions"];
  return (
    object(omissions) &&
    natural(omissions["metadataRecords"]) &&
    natural(omissions["thinkingBlocks"])
  );
}

export function validateCoverage(text: string, importId: string): void {
  const value: unknown = JSON.parse(text);
  if (
    !object(value) ||
    value["schemaVersion"] !== 1 ||
    value["importId"] !== importId ||
    !Array.isArray(value["files"]) ||
    !value["files"].every(coverageFile)
  )
    throw new Error("invalid-import");
}
