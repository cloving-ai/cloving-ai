import { createHash } from "node:crypto";
import { continues, isSettled, type GateState } from "../../authority/gates.ts";
import {
  eligibleIntents,
  type AuthorityState,
  type EffectIntent,
} from "../../authority/reducer.ts";
import { gateContinuation } from "../../authority/reduction.ts";

export interface DeliveryDecision {
  readonly gateId: string;
  readonly decision: string;
  readonly answer: string | null;
}

export interface DeliveryIntent
  extends EffectIntent, Partial<DeliveryDecision> {
  readonly workflow: string;
  readonly inputDigest: string;
}

export type Undigested = Omit<DeliveryIntent, "inputDigest">;

export function intentDigest(intent: Undigested): string {
  const base = [intent.kind, intent.runId, intent.operationId, intent.workflow];
  const bound =
    intent.gateId === undefined
      ? base
      : [
          ...base,
          intent.gateId,
          intent.decision ?? null,
          intent.answer ?? null,
        ];
  return createHash("sha256").update(JSON.stringify(bound)).digest("hex");
}

export function deliveryIntent(intent: Undigested): DeliveryIntent {
  return { ...intent, inputDigest: intentDigest(intent) };
}

export function gateDecision(
  gate: GateState | undefined,
): DeliveryDecision | null {
  if (gate === undefined || gate.kind === "untyped" || !continues(gate))
    return null;
  return {
    gateId: gate.gateId,
    decision: gate.outcome.decision,
    answer: gate.outcome.answer,
  };
}

function decisionOf(
  state: AuthorityState,
  intent: EffectIntent,
): DeliveryDecision | null {
  return gateDecision(
    Object.values(state.gates).find(
      (gate) =>
        gate.runId === intent.runId &&
        isSettled(gate) &&
        gateContinuation(gate).operationId === intent.operationId,
    ),
  );
}

export function stageable(
  state: AuthorityState,
  held: ReadonlySet<string>,
): readonly DeliveryIntent[] {
  return eligibleIntents(state)
    .filter((intent) => !held.has(intent.operationId))
    .map((intent) =>
      deliveryIntent({
        ...intent,
        workflow: state.runs[intent.runId]?.workflow ?? "",
        ...decisionOf(state, intent),
      }),
    );
}
