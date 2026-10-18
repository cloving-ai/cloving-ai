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

function identityFields(value: Record<string, unknown>): boolean {
  return (
    (value["uuid"] === null ||
      (typeof value["uuid"] === "string" && value["uuid"] !== "")) &&
    (value["isSidechain"] === null ||
      typeof value["isSidechain"] === "boolean") &&
    (!Object.hasOwn(value, "parentUuid") ||
      value["parentUuid"] === null ||
      (typeof value["parentUuid"] === "string" && value["parentUuid"] !== ""))
  );
}

function versionFields(value: Record<string, unknown>): boolean {
  const required = [
    "schemaVersion",
    "sourceId",
    "role",
    "timestamp",
    "sessionId",
    "text",
    "blocks",
  ];
  const version = value["schemaVersion"];
  if (version !== 1 && version !== 2) return false;
  const fields =
    version === 1
      ? { required }
      : {
          required: [...required, "uuid", "isSidechain"],
          optional: ["parentUuid"],
        };
  return keys(value, fields) && (version === 1 || identityFields(value));
}

function messageFields(value: Record<string, unknown>): boolean {
  return (
    versionFields(value) &&
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

export function parseCorpusRecord(line: string): MessageRecord {
  const value = parsePreservedJson(line);
  if (!message(value)) throw new Error("invalid-import");
  return value;
}

export function parseCorpus(text: string): readonly MessageRecord[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(parseCorpusRecord);
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
  if (!coverageSize(value)) return false;
  const omissions = value["omissions"];
  return (
    object(omissions) &&
    natural(omissions["metadataRecords"]) &&
    natural(omissions["thinkingBlocks"])
  );
}

export function validateCoverage(text: string, importId: string): void {
  const value: unknown = JSON.parse(text);
  if (!object(value) || value["importId"] !== importId)
    throw new Error("invalid-import");
  if (value["schemaVersion"] === 2 && scanCoverage(value)) return;
  if (
    value["schemaVersion"] === 1 &&
    Array.isArray(value["files"]) &&
    value["files"].every(coverageFile)
  )
    return;
  throw new Error("invalid-import");
}

function scanCoverage(value: Record<string, unknown>): boolean {
  const roots = value["roots"];
  const exclusions = value["exclusions"];
  const limits = value["limits"];
  const entries = value["entries"];
  return (
    keys(value, {
      required: [
        "schemaVersion",
        "importId",
        "roots",
        "exclusions",
        "limits",
        "entries",
      ],
    }) &&
    Array.isArray(roots) &&
    roots.length > 0 &&
    roots.every(absolutePath) &&
    Array.isArray(exclusions) &&
    exclusions.every(
      (name: unknown) =>
        typeof name === "string" &&
        name !== "" &&
        name !== "." &&
        name !== ".." &&
        !["/", "\\", "\0", "*", "?", "[", "]"].some((character) =>
          name.includes(character),
        ),
    ) &&
    coverageLimits(limits) &&
    Array.isArray(entries) &&
    entries.every((entry: unknown) => scanCoverageEntry(entry, roots))
  );
}

function coverageLimits(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, {
      required: ["depth", "files", "sourceBytes", "corpusBytes"],
    }) &&
    value["depth"] === 4 &&
    value["files"] === 100 &&
    value["sourceBytes"] === 10_485_760 &&
    value["corpusBytes"] === 52_428_800
  );
}

function scanCoverageEntry(value: unknown, roots: readonly string[]): boolean {
  if (!object(value) || !coverageFile({ ...value, status: "included" }))
    return false;
  if (
    !keys(value, {
      required: [
        "kind",
        "path",
        "selection",
        "status",
        "reason",
        "digest",
        "recordCount",
        "omissions",
      ],
      optional: ["byteSize"],
    })
  )
    return false;
  const selection = value["selection"];
  if (!coverageSelection(selection, roots.length)) return false;
  if (!["file", "subtree"].includes(String(value["kind"]))) return false;
  if (selection["kind"] === "file" && value["kind"] !== "file") return false;
  if (
    selection.kind === "root" &&
    !withinRoot(roots[selection.index], value["path"])
  )
    return false;
  return scanStatus(value, selection["kind"]);
}

function coverageSelection(
  value: unknown,
  rootCount: number,
): value is { readonly kind: "file" | "root"; readonly index: number } {
  if (
    !object(value) ||
    !keys(value, { required: ["kind", "index"] }) ||
    !natural(value["index"])
  )
    return false;
  return (
    value["kind"] === "file" ||
    (value["kind"] === "root" && value["index"] < rootCount)
  );
}

function scanStatus(
  value: Record<string, unknown>,
  selection: unknown,
): boolean {
  const status = value["status"];
  const reason = value["reason"];
  if (status === "included")
    return (
      value["kind"] === "file" &&
      reason === "supported" &&
      typeof value["digest"] === "string"
    );
  if (status === "unreadable")
    return reason === "source-unreadable" && emptyCoverageEntry(value);
  if (["too-large", "excluded", "pending"].includes(String(status)))
    return scanOmission(value, selection);
  return scanRefusal(value);
}

function scanRefusal(value: Record<string, unknown>): boolean {
  if (value["status"] !== "unsupported" || value["recordCount"] !== 0)
    return false;
  const contentReasons = [
    "invalid-utf8",
    "empty-file",
    "invalid-json",
    "unsupported-record",
    "unsupported-message",
    "unsupported-block",
  ];
  if (contentReasons.includes(String(value["reason"])))
    return value["kind"] === "file" && typeof value["digest"] === "string";
  const reasons =
    value["kind"] === "subtree"
      ? [
          "symbolic-link",
          "nonregular-file",
          "outside-root",
          "repository-root",
          "source-changed",
          "non-directory-root",
        ]
      : [
          "symbolic-link",
          "nonregular-file",
          "outside-root",
          "source-changed",
          "unsupported-extension",
          "file-too-large",
        ];
  return reasons.includes(String(value["reason"])) && emptyCoverageEntry(value);
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

export function withinRoot(root: string | undefined, path: unknown): boolean {
  if (root === undefined || !absolutePath(path)) return false;
  const parent = root.split("/").filter(Boolean);
  const child = path.split("/").filter(Boolean);
  return parent.every((part, index) => part === child[index]);
}

function scanOmission(
  value: Record<string, unknown>,
  selection: unknown,
): boolean {
  if (!emptyCoverageEntry(value)) return false;
  if (value["status"] === "too-large")
    return selection === "file" && value["reason"] === "file-too-large";
  if (selection !== "root") return false;
  if (value["status"] === "excluded")
    return (
      value["kind"] === "subtree" && value["reason"] === "project-excluded"
    );
  return (
    value["reason"] ===
    (value["kind"] === "subtree" ? "depth-limit" : "file-limit")
  );
}

function emptyCoverageEntry(value: Record<string, unknown>): boolean {
  const omissions = value["omissions"];
  return (
    value["digest"] === null &&
    value["recordCount"] === 0 &&
    object(omissions) &&
    omissions["metadataRecords"] === 0 &&
    omissions["thinkingBlocks"] === 0
  );
}

function coverageSize(value: Record<string, unknown>): boolean {
  return (
    !Object.hasOwn(value, "byteSize") ||
    (natural(value["byteSize"]) && value["byteSize"] <= 10_485_760)
  );
}
