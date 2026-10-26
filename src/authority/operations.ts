import { operationScope } from "../operation-identity.ts";

export type OperationStatus =
  | "refused"
  | "waiting"
  | "dispatch-pending"
  | "running"
  | "recovering"
  | "blocked"
  | "completed"
  | "failed"
  | "stopped"
  | "cancelled";

export interface Operation {
  readonly runId: string;
  readonly operationId: string;
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  readonly payload: string;
  readonly inputDigest: string;
  readonly units: number;
  readonly leaseKey: string;
  readonly recoveryLimit: number;
  readonly status: OperationStatus;
  readonly reason: string | null;
  readonly attempts: number;
  readonly receipt: string | null;
  readonly worker: string | null;
  readonly result: string | null;
  readonly requestedSequence: number;
  readonly waitSequence: number | null;
  readonly settledSequence: number | null;
}

export interface Lease {
  readonly resourceKey: string;
  readonly operationId: string;
  readonly generation: number;
  readonly expiresAt: string;
  readonly state: "held" | "expired" | "released";
  readonly grantedSequence: number;
}

export interface RunBudget {
  readonly runId: string;
  readonly limit: number;
  readonly spent: number;
  readonly capabilities: readonly string[];
  readonly exhaustedSequence: number | null;
}

export interface StoppedOperation {
  readonly runId: string;
  readonly sequence: number;
}

export interface EffectState {
  readonly budgets: Readonly<Record<string, RunBudget>>;
  readonly operations: Readonly<Record<string, Operation>>;
  readonly leases: Readonly<Record<string, Lease>>;
  readonly holding: number;
  readonly stops: Readonly<Record<string, StoppedOperation>>;
}

export const emptyEffects: EffectState = {
  budgets: {},
  operations: {},
  leases: {},
  holding: 0,
  stops: {},
};

export interface Disposition {
  readonly operationId: string;
  readonly disposition: string;
  readonly reason: string | null;
}

export interface Evidence extends Disposition {
  readonly sequence: number;
  readonly runId: string;
}

export function evidenceOf(
  event: { readonly sequence: number; readonly runId: string },
  disposition: Disposition | undefined,
): readonly Evidence[] {
  if (disposition === undefined) return [];
  return [{ sequence: event.sequence, runId: event.runId, ...disposition }];
}

export interface EffectChange {
  readonly kind: "changed";
  readonly effects: EffectState;
  readonly added?: readonly string[];
  readonly released?: readonly string[];
  readonly disposition?: Disposition;
}

export type EffectResult =
  EffectChange | { readonly kind: "invalid"; readonly reason: string };

export interface EffectEvent {
  readonly sequence: number;
  readonly runId: string;
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, string>>;
}

export interface EffectContext {
  readonly event: EffectEvent;
  readonly runStatus: string;
}

const holdingStatuses: readonly string[] = [
  "dispatch-pending",
  "running",
  "recovering",
  "blocked",
];

const finalStatuses: readonly OperationStatus[] = [
  "refused",
  "completed",
  "failed",
  "stopped",
  "cancelled",
];

export const runOperations = ["start-run", "continue-run", "resume-hook"];

export function namesRunIntent(operationId: string, runId: string): boolean {
  const scope = operationScope(operationId);
  return scope?.run === runId && runOperations.includes(scope.operation);
}

export function isHolding(operation: { readonly status: string }): boolean {
  return holdingStatuses.includes(operation.status);
}

export function isFinal(operation: Operation): boolean {
  return finalStatuses.includes(operation.status);
}

export function rejected(reason: string): EffectResult {
  return { kind: "invalid", reason };
}

export function field(event: EffectEvent, name: string): string {
  return event.payload[name] ?? "";
}

export function count(event: EffectEvent, name: string): number {
  return Number(event.payload[name]);
}

export function withOperation(
  effects: EffectState,
  operation: Operation,
): EffectState {
  return {
    ...effects,
    operations: { ...effects.operations, [operation.operationId]: operation },
  };
}

export function cancelledOperation(
  operation: Operation,
  cancellation: { readonly reason: string; readonly sequence: number },
): Operation {
  return {
    ...operation,
    status: "cancelled",
    reason: cancellation.reason,
    waitSequence: null,
    settledSequence: cancellation.sequence,
  };
}

export function endedRun(
  effects: EffectState,
  event: { readonly runId: string; readonly sequence: number },
): EffectState {
  return {
    ...effects,
    operations: Object.fromEntries(
      Object.entries(effects.operations).map(([operationId, operation]) => [
        operationId,
        operation.runId === event.runId && operation.status === "waiting"
          ? cancelledOperation(operation, {
              reason: "run-ended",
              sequence: event.sequence,
            })
          : operation,
      ]),
    ),
  };
}
