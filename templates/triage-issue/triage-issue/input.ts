import type { CycleOutcome, ProtectedResult } from "cloving/workflows";

export interface TriageInput {
  readonly cycleId: string;
  readonly input: { readonly issue?: number };
}

export function blocked(
  request: { readonly cycleId: string },
  reason: string,
): CycleOutcome {
  return {
    kind: "blocked",
    cycleId: request.cycleId,
    evidenceId: "triage-issue",
    reason: reason,
  };
}

export function failureReason(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
    ? error.message
    : "triage-failed";
}

export function resultText(result: ProtectedResult): string {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  return result.result ?? "null";
}
