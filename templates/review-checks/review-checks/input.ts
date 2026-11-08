import type { CycleOutcome, ProtectedResult } from "cloving/workflows";

export interface ChecksInput {
  readonly cycleId: string;
  readonly input: { readonly text?: string };
}

export type Fields = Readonly<Record<string, unknown>>;

export interface TextRule {
  readonly reason: string;
  readonly pattern: RegExp;
  readonly maximum: number;
}

export function blocked(
  request: { readonly cycleId: string },
  reason: string,
): CycleOutcome {
  return {
    kind: "blocked",
    cycleId: request.cycleId,
    evidenceId: "review-checks",
    reason: reason,
  };
}

export function failureReason(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
    ? error.message
    : "review-checks-failed";
}

export function resultJson(result: ProtectedResult, reason: string): unknown {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  try {
    const value: unknown = JSON.parse(result.result ?? "");
    return value;
  } catch {
    throw new Error(reason);
  }
}

export function record(value: unknown, reason: string): Fields {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value));
  throw new Error(reason);
}

export function list(
  value: unknown,
  rule: { readonly reason: string; readonly maximum: number },
): readonly unknown[] {
  if (Array.isArray(value) && value.length <= rule.maximum)
    return value.map((item: unknown) => item);
  throw new Error(rule.reason);
}

export function text(value: unknown, rule: TextRule): string {
  if (
    typeof value === "string" &&
    value.length <= rule.maximum &&
    rule.pattern.test(value)
  )
    return value;
  throw new Error(rule.reason);
}

export function count(value: unknown, reason: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  throw new Error(reason);
}
