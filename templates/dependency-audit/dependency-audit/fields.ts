import type { ProtectedResult } from "cloving/workflows";

export type Fields = Readonly<Record<string, unknown>>;

export interface LineRule {
  readonly reason: string;
  readonly pattern: RegExp;
  readonly maximum: number;
}

export const packageName = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;

export function failure(reason: string): never {
  throw new Error(reason);
}

export function effectText(result: ProtectedResult, missing: string): string {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  if (result.result === null) failure(missing);
  return result.result;
}

export function parsed(text: string, reason: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return failure(reason);
  }
}

export function fields(value: unknown, reason: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    failure(reason);
  return Object.fromEntries(Object.entries(value));
}

export function items(
  value: unknown,
  rule: {
    readonly reason: string;
    readonly minimum: number;
    readonly maximum: number;
  },
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < rule.minimum ||
    value.length > rule.maximum
  )
    failure(rule.reason);
  return value.map((item: unknown) => item);
}

export function line(value: unknown, rule: LineRule): string {
  if (typeof value !== "string") failure(rule.reason);
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > rule.maximum || !rule.pattern.test(text))
    failure(rule.reason);
  return text;
}
