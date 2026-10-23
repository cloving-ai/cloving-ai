import type { RunDetails } from "./details.ts";
import type { GateState } from "./gates.ts";
import type { EffectState } from "./operations.ts";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_gate"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunState {
  readonly runId: string;
  readonly status: RunStatus;
  readonly revision: number;
  readonly workflow: string;
  readonly pausedFrom: RunStatus | null;
  readonly gates: readonly string[];
}

export interface EffectIntent {
  readonly kind: "start-run" | "continue-run" | "protected-effect";
  readonly runId: string;
  readonly operationId: string;
}

export interface AuthorityState {
  readonly sequence: number;
  readonly runs: Readonly<Record<string, RunState>>;
  readonly commands: Readonly<
    Record<string, { readonly request: string; readonly sequence: number }>
  >;
  readonly intents: readonly EffectIntent[];
  readonly gates: Readonly<Record<string, GateState>>;
  readonly details: Readonly<Record<string, RunDetails>>;
  readonly questions: number;
  readonly effects: EffectState;
}

export const eventTypes = [
  "run.created",
  "run.started",
  "gate.opened",
  "gate.wait-registered",
  "gate.decided",
  "gate.expired",
  "run.paused",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.observed",
  "step.dispatched",
  "effect.requested",
  "lease.granted",
  "lease.expired",
  "effect.reported",
  "operation.reconciled",
] as const;

export type EventType = (typeof eventTypes)[number];

export interface AuthorityEvent {
  readonly sequence: number;
  readonly type: EventType;
  readonly runId: string;
  readonly commandId: string;
  readonly recordedAt: string;
  readonly request: string;
  readonly payload: Readonly<Record<string, string>>;
}

export const numberFields = [
  "expectedRevision",
  "generation",
  "attempt",
  "limit",
  "effectLimit",
  "units",
  "recoveryLimit",
  "leaseGeneration",
  "sourceGeneration",
  "capacity",
] as const;

export const textFields = [
  "workflow",
  "submission",
  "input",
  "resolver",
  "gateId",
  "gateKind",
  "subject",
  "prompt",
  "expiresAt",
  "decision",
  "answer",
  "condition",
  "reason",
  "evidence",
  "retryAt",
  "operationId",
  "receipt",
  "capabilities",
  "capability",
  "method",
  "target",
  "payload",
  "inputDigest",
  "resource",
  "transport",
  "source",
  "worker",
  "outcome",
  "outcomeReason",
  "promotionId",
  "ticketStatus",
  "issueUpdate",
  "result",
] as const;

export type NumberField = (typeof numberFields)[number];
export type TextField = (typeof textFields)[number];

export type AuthorityCommand = {
  readonly kind: string;
  readonly commandId: string;
  readonly runId: string;
} & Readonly<Partial<Record<NumberField, number>>> &
  Readonly<Partial<Record<TextField, string>>>;

export type Move = Exclude<
  EventType,
  | "run.created"
  | "step.dispatched"
  | "gate.wait-registered"
  | "run.observed"
  | "effect.requested"
  | "lease.granted"
  | "lease.expired"
  | "effect.reported"
  | "operation.reconciled"
>;
type Change = Pick<RunState, "status"> & Partial<RunState>;

export const terminal: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];
const active: readonly RunStatus[] = ["queued", "running", "waiting_gate"];

const sources: Readonly<
  Record<Exclude<Move, "run.resumed">, readonly RunStatus[]>
> = {
  "run.started": ["queued"],
  "gate.opened": ["running", "waiting_gate"],
  "gate.decided": ["waiting_gate"],
  "gate.expired": ["waiting_gate"],
  "run.paused": active,
  "run.completed": ["running"],
  "run.failed": active,
  "run.cancelled": [...active, "paused"],
};

const changes: Readonly<
  Record<
    Exclude<Move, "run.resumed" | "gate.decided" | "gate.expired">,
    (run: RunState, gateId: string) => Change
  >
> = {
  "run.started": () => ({ status: "running" }),
  "gate.opened": (run, gateId) => ({
    status: "waiting_gate",
    gates: [...run.gates, gateId],
  }),
  "run.paused": (run) => ({ status: "paused", pausedFrom: run.status }),
  "run.completed": () => ({ status: "completed" }),
  "run.failed": () => ({ status: "failed" }),
  "run.cancelled": () => ({ status: "cancelled" }),
};

export type Transition =
  | { readonly kind: "moved"; readonly run: RunState }
  | { readonly kind: "invalid"; readonly reason: string };

export function transition(
  run: RunState,
  event: { readonly type: Move; readonly gateId: string },
): Transition {
  const { type, gateId } = event;
  if (terminal.includes(run.status)) return invalid("terminal-run");
  if (type === "run.resumed")
    return run.pausedFrom
      ? moved(run, { status: run.pausedFrom, pausedFrom: null })
      : invalid("invalid-transition");
  if (!sources[type].includes(run.status)) return invalid("invalid-transition");
  if (type === "gate.opened" && run.gates.includes(gateId))
    return invalid("existing-gate");
  if (type === "gate.decided" || type === "gate.expired")
    return run.gates.includes(gateId)
      ? moved(run, decided(run, gateId))
      : invalid("unknown-gate");
  return moved(run, changes[type](run, gateId));
}

function decided(run: RunState, gateId: string): Change {
  const gates = run.gates.filter((gate) => gate !== gateId);
  return { status: gates.length === 0 ? "running" : "waiting_gate", gates };
}

function moved(run: RunState, change: Change): Transition {
  return {
    kind: "moved",
    run: { ...run, ...change, revision: run.revision + 1 },
  };
}

function invalid(reason: string): Transition {
  return { kind: "invalid", reason };
}
