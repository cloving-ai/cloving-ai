import type { CycleOutcome, ProtectedResult } from "cloving/workflows";

export function blocked(state: {
  readonly cycleId: string;
  readonly reason: string;
  readonly evidenceId: string;
}): CycleOutcome {
  return {
    kind: "blocked",
    cycleId: state.cycleId,
    reason: state.reason,
    evidenceId: state.evidenceId,
  };
}

export function failureReason(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
    ? error.message
    : "release-failed";
}

export function fields(
  value: unknown,
  reason: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(reason);
  return Object.fromEntries(Object.entries(value));
}

export function resultValue(
  result: ProtectedResult,
  reason: string,
): Record<string, unknown> {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  return fields(parsed(result.result ?? "null", reason), reason);
}

function parsed(text: string, reason: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(reason);
  }
}
