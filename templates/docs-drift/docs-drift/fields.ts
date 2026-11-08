import type { ProtectedResult } from "cloving/workflows";

export type Fields = Readonly<Record<string, unknown>>;

export interface TextRule {
  readonly reason: string;
  readonly pattern: RegExp;
  readonly maximum: number;
}

export function failure(reason: string): never {
  throw new Error(reason);
}

export function completedText(
  result: ProtectedResult,
  missing: string,
): string {
  if (result.kind === "completed") return result.result ?? failure(missing);
  return failure(result.reason ?? result.kind);
}

export function jsonValue(source: string, reason: string): unknown {
  try {
    const value: unknown = JSON.parse(source);
    return value;
  } catch {
    return failure(reason);
  }
}

export function record(value: unknown, reason: string): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : failure(reason);
}

export function list(
  value: unknown,
  rule: { readonly reason: string; readonly maximum: number },
): readonly unknown[] {
  return Array.isArray(value) && value.length <= rule.maximum
    ? value.map((item: unknown) => item)
    : failure(rule.reason);
}

export function text(value: unknown, rule: TextRule): string {
  const found =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return found.length <= rule.maximum && rule.pattern.test(found)
    ? found
    : failure(rule.reason);
}
