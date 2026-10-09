export type VerificationFailure =
  | { readonly kind: "ordinary"; readonly diagnostics: readonly string[] }
  | { readonly kind: "policy-change"; readonly proposal: string };

export type VerificationRepair =
  | { readonly action: "repair"; readonly attempt: number }
  | { readonly action: "design-decision"; readonly proposal: string }
  | { readonly action: "blocked"; readonly reason: string };

export function routeVerificationFailure(
  failure: VerificationFailure,
  budget: { readonly attempts: number; readonly limit: number },
): VerificationRepair {
  if (
    !Number.isSafeInteger(budget.attempts) ||
    !Number.isSafeInteger(budget.limit) ||
    budget.attempts < 0 ||
    budget.limit < 1 ||
    budget.attempts > budget.limit
  )
    throw new Error("invalid-verification-repair-budget");
  validateFailure(failure);
  if (failure.kind === "policy-change")
    return { action: "design-decision", proposal: failure.proposal };
  if (budget.attempts === budget.limit)
    return {
      action: "blocked",
      reason: "verification-repair-budget-exhausted",
    };
  return { action: "repair", attempt: budget.attempts + 1 };
}

function validateFailure(failure: VerificationFailure): void {
  const details =
    failure.kind === "ordinary" ? failure.diagnostics : [failure.proposal];
  if (
    details.length === 0 ||
    details.some((value) => value.trim().length === 0)
  )
    throw new Error("invalid-verification-failure");
}
