import {
  assessed,
  type Assessment,
  type EffectSummary,
} from "./status-input.ts";

export interface EffectView {
  readonly operationId: string;
  readonly state: string;
  readonly reason: string | null;
  readonly leaseGeneration: number | null;
  readonly attempts: number;
  readonly limit: number;
}

export interface Recovery {
  readonly attempts: number;
  readonly limit: number | null;
}

const blocked = assessed("uncertain-effect", {
  code: "effect-blocked",
  nextAction: "inspect-effect",
  humanInputCanHelp: true,
});

const recovering = assessed("uncertain-effect", {
  code: "effect-recovering",
  nextAction: "reconcile-effect",
  humanInputCanHelp: false,
});

export function uncertainEffect(
  effects: readonly EffectSummary[],
): Assessment | undefined {
  const statuses = effects.map((effect) => effect.status);
  if (statuses.includes("blocked")) return blocked;
  return statuses.includes("recovering") ? recovering : undefined;
}

function shownReason(effect: EffectSummary): string | null {
  const ready = effect.status === "waiting" && effect.reason === "ready";
  return ready ? "capacity" : effect.reason;
}

export function effectViews(
  effects: readonly EffectSummary[],
): readonly EffectView[] {
  return effects.map((effect) => ({
    operationId: effect.operationId,
    state: effect.status,
    reason: shownReason(effect),
    leaseGeneration: effect.leaseGeneration,
    attempts: effect.attempts,
    limit: effect.limit,
  }));
}

const uncertainStatuses = ["recovering", "blocked"];

export function effectRecovery(
  effects: readonly EffectSummary[],
): Recovery | undefined {
  const [largest] = effects
    .filter((effect) => uncertainStatuses.includes(effect.status))
    .sort((left, right) => right.attempts - left.attempts);
  if (largest === undefined) return undefined;
  return { attempts: largest.attempts, limit: largest.limit };
}

export function effectEvidence(
  sequences: readonly number[],
): readonly string[] {
  return sequences.map((sequence) => `event:${String(sequence)}`);
}
