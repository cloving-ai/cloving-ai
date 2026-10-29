import type { CycleOutcome, ProtectedResult } from "cloving/workflows";

export interface IdeaInput {
  readonly cycleId: string;
  readonly input: { readonly idea: string };
}

export const draft = "cloving-prd-draft.md";

export function effectResult(result: ProtectedResult): string | null {
  if (result.kind !== "completed")
    throw new Error(
      "reason" in result && result.reason !== null
        ? result.reason
        : result.kind,
    );
  return result.result;
}

export function resultFields(result: string | null): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(result ?? "null");
  } catch {
    throw new Error("invalid-issue-result");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid-issue-result");
  return Object.fromEntries(Object.entries(value));
}

export function issueOutcome(input: IdeaInput, number: number): CycleOutcome {
  return {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: `issue-${String(number)}`,
  };
}
