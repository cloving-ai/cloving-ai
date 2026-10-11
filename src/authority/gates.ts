import { notBefore } from "./instants.ts";

export type GateKind = "question" | "approval" | "untyped";

export interface GateOutcome {
  readonly decision: string | null;
  readonly answer: string | null;
  readonly sequence: number;
}

export interface GateState {
  readonly runId: string;
  readonly gateId: string;
  readonly kind: GateKind;
  readonly label: number | null;
  readonly subject: string | null;
  readonly prompt: string | null;
  readonly expiresAt: string | null;
  readonly generation: number;
  readonly revision: number;
  readonly wait: "registered" | "pending";
  readonly outcome: GateOutcome | null;
  readonly openedSequence: number;
}

type Payload = Readonly<Record<string, string>>;

const allowed: Readonly<Record<GateKind, readonly string[] | null>> = {
  question: ["answered"],
  approval: ["approved", "denied"],
  untyped: null,
};

const kinds: Readonly<Record<string, GateKind>> = {
  question: "question",
  approval: "approval",
};

export function allowedDecisions(kind: GateKind): readonly string[] | null {
  return allowed[kind];
}

export function reusable(
  existing: GateState | undefined,
  next: GateState,
): boolean {
  if (existing === undefined) return true;
  return existing.kind === "untyped" && next.kind === "untyped";
}

export function gateKey(runId: string, gateId: string): string {
  return `${runId} ${gateId}`;
}

export function openedGate(opening: {
  readonly runId: string;
  readonly sequence: number;
  readonly payload: Payload;
  readonly generation: number;
  readonly label: number | null;
}): GateState {
  const { payload } = opening;
  const kind = kinds[payload["gateKind"] ?? ""] ?? "untyped";
  return {
    runId: opening.runId,
    gateId: payload["gateId"] ?? "",
    kind,
    label: opening.label,
    subject: payload["subject"] ?? null,
    prompt: payload["prompt"] ?? null,
    expiresAt: payload["expiresAt"] ?? null,
    generation: opening.generation,
    revision: 1,
    wait: kind === "untyped" ? "registered" : "pending",
    outcome: null,
    openedSequence: opening.sequence,
  };
}

function untypedRefusal(payload: Payload): string | undefined {
  const bound =
    payload["generation"] !== undefined || payload["subject"] !== undefined;
  return bound ? "decision-not-allowed" : undefined;
}

export function decisionRefusal(
  gate: GateState,
  decision: { readonly payload: Payload; readonly recordedAt: string },
): string | undefined {
  const { payload, recordedAt } = decision;
  if (gate.kind === "untyped") return untypedRefusal(payload);
  if (gate.outcome !== null) return "decision-not-pending";
  if (payload["generation"] !== String(gate.generation))
    return "stale-generation";
  if (payload["subject"] !== gate.subject) return "subject-mismatch";
  if (!allowed[gate.kind]?.includes(payload["decision"] ?? ""))
    return "decision-not-allowed";
  if (gate.expiresAt !== null && notBefore(recordedAt, gate.expiresAt))
    return "decision-expired";
  return undefined;
}

export function expiryRefusal(
  gate: GateState,
  recordedAt: string,
): string | undefined {
  if (gate.outcome !== null) return "decision-not-pending";
  if (gate.expiresAt === null || !notBefore(recordedAt, gate.expiresAt))
    return "not-expired";
  return undefined;
}

export function settled(gate: GateState, outcome: GateOutcome): GateState {
  return { ...gate, outcome, revision: gate.revision + 1 };
}

export type SettledGate = GateState & { readonly outcome: GateOutcome };

export function isSettled(gate: GateState): gate is SettledGate {
  return gate.outcome !== null;
}

export type ContinuingGate = GateState & {
  readonly outcome: GateOutcome & { readonly decision: string };
};

export function continues(gate: GateState): gate is ContinuingGate {
  return (
    gate.wait === "registered" &&
    isSettled(gate) &&
    gate.outcome.decision !== null
  );
}
