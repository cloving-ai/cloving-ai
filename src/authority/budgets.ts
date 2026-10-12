import { authorizeEffect } from "../effect-authorization.ts";
import {
  count,
  field,
  type EffectEvent,
  type EffectState,
  type RunBudget,
} from "./operations.ts";

type Payload = Readonly<Record<string, string>>;

function capabilityList(text: string): readonly string[] {
  const value: unknown = JSON.parse(text);
  return Array.isArray(value) ? value.map(String) : [];
}

export function admittedBudgets(
  budgets: EffectState["budgets"],
  admission: { readonly runId: string; readonly payload: Payload },
): EffectState["budgets"] {
  const { runId, payload } = admission;
  const limit = payload["effectLimit"];
  if (limit === undefined) return budgets;
  return {
    ...budgets,
    [runId]: {
      runId,
      limit: Number(limit),
      spent: 0,
      capabilities: capabilityList(payload["capabilities"] ?? "[]"),
      exhaustedSequence: null,
    },
  };
}

export interface Authorization {
  readonly reason: string | null;
  readonly budget: RunBudget | undefined;
}

const exhausted = "budget-exhausted";

export function authorization(
  budget: RunBudget | undefined,
  event: EffectEvent,
): Authorization {
  if (budget === undefined || budget.exhaustedSequence !== null)
    return { reason: exhausted, budget };
  const result = authorizeEffect(
    { capabilities: budget.capabilities },
    {
      budget: { limit: budget.limit, spent: budget.spent },
      request: {
        capability: field(event, "capability"),
        units: count(event, "units"),
      },
    },
  );
  if (result.kind === "authorized")
    return { reason: null, budget: { ...budget, spent: result.spent } };
  return {
    reason: result.reason,
    budget:
      result.reason === exhausted
        ? { ...budget, exhaustedSequence: event.sequence }
        : budget,
  };
}
