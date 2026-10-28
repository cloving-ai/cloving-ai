import { createHash } from "node:crypto";
import { delivers, isSettled, type GateState } from "../../authority/gates.ts";
import {
  eligibleIntents,
  type AuthorityState,
  type EffectIntent,
} from "../../authority/reducer.ts";
import { gateDelivery } from "../../authority/reduction.ts";
import type { ExecutionManifest } from "../../workflow-admission.ts";

export interface DeliveryDecision {
  readonly gateId: string;
  readonly decision: string;
  readonly answer: string | null;
}

export type Purpose = "dispatch" | "reconcile" | "stop";

export interface EffectArguments {
  readonly leaseGeneration: number;
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  readonly payload: string;
}

export interface DeliveryIntent
  extends EffectIntent, Partial<DeliveryDecision>, Partial<EffectArguments> {
  readonly workflow: string;
  readonly inputDigest: string;
  readonly purpose: Purpose;
  readonly commandDeadline?: string;
}

export type ProtectedIntent = DeliveryIntent & EffectArguments;

export type Undigested = Omit<DeliveryIntent, "inputDigest" | "purpose">;

export type Reconciliation =
  | {
      readonly kind: "accepted";
      readonly receipt: string;
      readonly worker?: string;
    }
  | { readonly kind: "absent" };

export type AdapterOutcome =
  | Reconciliation
  | {
      readonly kind: "completed";
      readonly receipt: string;
      readonly worker?: string;
      readonly result: string;
    }
  | {
      readonly kind: "failed";
      readonly receipt?: string;
      readonly reason: string;
      readonly result?: string;
    }
  | { readonly kind: "stopped"; readonly receipt?: string }
  | { readonly kind: "unknown"; readonly evidence?: string };

export interface Delivery {
  readonly deliver: (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ) => Promise<
    { readonly receipt: string; readonly worker?: string } | AdapterOutcome
  >;
  readonly reconcile: (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ) => Promise<AdapterOutcome>;
  readonly retry?: Delivery["reconcile"];
  readonly stop?: (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ) => Promise<AdapterOutcome>;
}

export type AvailableManifest = (
  pinned: ExecutionManifest,
) => ExecutionManifest | undefined | Promise<ExecutionManifest | undefined>;

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
  return { ...intent, purpose: "dispatch", inputDigest: intentDigest(intent) };
}

export function protectedIntent(
  state: AuthorityState,
  attempt: { readonly intent: EffectIntent; readonly purpose: Purpose },
): readonly DeliveryIntent[] {
  const { intent, purpose } = attempt;
  const workflow = workflowOf(state, intent.runId);
  return Object.values(state.effects.operations)
    .filter((operation) => operation.operationId === intent.operationId)
    .flatMap((operation) =>
      Object.values(state.effects.leases)
        .filter((lease) => lease.resourceKey === operation.leaseKey)
        .map((lease) => ({
          ...intent,
          workflow,
          purpose,
          inputDigest: operation.inputDigest,
          leaseGeneration: lease.generation,
          capability: operation.capability,
          method: operation.method,
          target: operation.target,
          payload: operation.payload,
        })),
    );
}

export function gateDecision(
  gate: GateState | undefined,
): DeliveryDecision | null {
  if (gate === undefined || gate.kind === "untyped" || !delivers(gate))
    return null;
  return {
    gateId: gate.gateId,
    decision: gate.outcome.decision,
    answer: gate.outcome.answer,
  };
}

function workflowOf(state: AuthorityState, runId: string): string {
  return state.runs[runId]?.workflow ?? "";
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
        gateDelivery(gate).operationId === intent.operationId,
    ),
  );
}

export function observingIntent(
  state: AuthorityState,
  attempt: { readonly intent: EffectIntent; readonly purpose: Purpose },
): DeliveryIntent {
  const { intent, purpose } = attempt;
  const undigested = {
    ...intent,
    workflow: workflowOf(state, intent.runId),
    ...decisionOf(state, intent),
  };
  return { ...undigested, purpose, inputDigest: intentDigest(undigested) };
}

export function stageable(
  state: AuthorityState,
  held: ReadonlySet<string>,
): readonly DeliveryIntent[] {
  return eligibleIntents(state)
    .filter((intent) => !held.has(intent.operationId))
    .flatMap((intent) =>
      intent.kind === "protected-effect"
        ? protectedIntent(state, { intent, purpose: "dispatch" })
        : [
            deliveryIntent({
              ...intent,
              workflow: workflowOf(state, intent.runId),
              ...decisionOf(state, intent),
            }),
          ],
    );
}
