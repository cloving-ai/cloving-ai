export interface CloneFinding {
  readonly first: { readonly file: string; readonly line: number };
  readonly second: { readonly file: string; readonly line: number };
  readonly tokens: number;
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid clone report object");
}

function object(value: unknown): Record<string, unknown> {
  assertRecord(value);
  return value;
}

function count(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error("Invalid clone report count");
  return value;
}

function location(value: unknown): { file: string; line: number } {
  const record = object(value);
  if (typeof record["name"] !== "string" || record["name"].length === 0)
    throw new Error("Invalid clone report filename");
  return { file: record["name"], line: count(record["start"], 1) };
}

function clone(value: unknown): CloneFinding {
  const record = object(value);
  if (
    record["kind"] !== "exact" ||
    !["typescript", "javascript", "tsx", "jsx"].includes(
      String(record["format"]),
    )
  )
    throw new Error("Unexpected clone report detection mode");
  count(record["lines"], 1);
  return {
    first: location(record["firstFile"]),
    second: location(record["secondFile"]),
    tokens: count(record["tokens"], 150),
  };
}

export function parseCloneReport(value: unknown): CloneFinding[] {
  const report = object(value);
  const duplicates = report["duplicates"];
  const total = object(object(report["statistics"])["total"]);
  if (
    !Array.isArray(duplicates) ||
    count(total["clones"], 0) !== duplicates.length
  )
    throw new Error("Inconsistent clone report duplicates");
  count(total["sources"], 0);
  count(total["tokens"], 0);
  count(total["lines"], 0);
  return duplicates.map((entry: unknown) => clone(entry));
}
