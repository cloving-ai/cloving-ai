import type { CycleOutcome, ProtectedResult } from "cloving/workflows";

export interface IdeaInput {
  readonly cycleId: string;
  readonly input: { readonly idea: string };
}

export const draft = "cloving-prd-draft.md";

export function failureReason(failure: unknown, fallback: string): string {
  if (typeof failure !== "object" || failure === null) return fallback;
  const cause = "cause" in failure ? failure.cause : failure;
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("message" in cause) ||
    typeof cause.message !== "string"
  )
    return fallback;
  return /^[a-z][a-z0-9-]{0,127}$/.test(cause.message)
    ? cause.message
    : fallback;
}

export function effectResult(result: ProtectedResult): string | null {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  return result.result;
}

export function resultFields(result: string | null): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(result ?? "null");
  } catch {
    throw new Error("invalid-issue-result");
  }
  if (!resultObject(value)) throw new Error("invalid-issue-result");
  return value;
}

function resultObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function issueOutcome(input: IdeaInput, number: number): CycleOutcome {
  return {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: `issue-${String(number)}`,
  };
}
