export interface EffectBudget {
  readonly limit: number;
  readonly spent: number;
}

export interface EffectRequest {
  readonly capability: string;
  readonly units: number;
}

export type EffectAuthorization =
  | { readonly kind: "authorized"; readonly spent: number }
  | { readonly kind: "rejected"; readonly reason: string };

export function authorizeEffect(
  manifest: { readonly capabilities: readonly string[] },
  effect: { readonly budget: EffectBudget; readonly request: EffectRequest },
): EffectAuthorization {
  const { budget, request } = effect;
  if (
    ![budget.limit, budget.spent].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !Number.isSafeInteger(request.units) ||
    request.units < 1 ||
    budget.spent > budget.limit
  )
    return { kind: "rejected", reason: "invalid-effect-request" };
  if (!manifest.capabilities.includes(request.capability))
    return { kind: "rejected", reason: "unadmitted-capability" };
  const spent = budget.spent + request.units;
  if (spent > budget.limit)
    return { kind: "rejected", reason: "budget-exhausted" };
  return { kind: "authorized", spent };
}
