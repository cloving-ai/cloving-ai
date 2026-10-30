import { operationScope, operationPhase } from "../operation-identity.ts";
import { authorization } from "./budgets.ts";
import { current, ownedLease } from "./leases.ts";
import {
  cancelledOperation,
  count,
  field,
  rejected,
  runOperations,
  withOperation,
  type EffectContext,
  type EffectEvent,
  type EffectResult,
  type EffectState,
  type Operation,
} from "./operations.ts";

const admittingStatuses = ["running", "paused", "waiting_gate"];
const terminalStatuses = ["completed", "failed", "cancelled"];
const compared = [
  "capability",
  "method",
  "target",
  "payload",
  "inputDigest",
] as const;

function refusal(context: EffectContext): string | undefined {
  const { event, runStatus } = context;
  if (terminalStatuses.includes(runStatus)) return "terminal-run";
  if (!admittingStatuses.includes(runStatus)) return "run-not-running";
  const scope = operationScope(field(event, "operationId"));
  if (
    scope?.run !== event.runId ||
    operationPhase(field(event, "operationId")) === "command-wait"
  )
    return "operation-scope-mismatch";
  if (runOperations.includes(scope.operation))
    return "operation-scope-mismatch";
  return undefined;
}

function leaseKeyOf(event: EffectEvent): string {
  return event.payload["resource"] ?? field(event, "operationId");
}

function equalInput(operation: Operation, event: EffectEvent): boolean {
  return (
    compared.every((name) => operation[name] === field(event, name)) &&
    operation.units === count(event, "units") &&
    operation.leaseKey === leaseKeyOf(event)
  );
}

function waitReason(
  effects: EffectState,
  wait: { readonly leaseKey: string; readonly runStatus: string },
): string {
  const lease = effects.leases[wait.leaseKey];
  if (lease !== undefined && lease.state !== "released") return "resource";
  return wait.runStatus === "running" ? "ready" : "run-not-running";
}

function requestedOperation(
  event: EffectEvent,
  outcome: Pick<Operation, "status" | "reason" | "waitSequence">,
): Operation {
  return {
    runId: event.runId,
    operationId: field(event, "operationId"),
    capability: field(event, "capability"),
    method: field(event, "method"),
    target: field(event, "target"),
    payload: field(event, "payload"),
    inputDigest: field(event, "inputDigest"),
    units: count(event, "units"),
    leaseKey: leaseKeyOf(event),
    recoveryLimit: count(event, "recoveryLimit"),
    ...outcome,
    attempts: 0,
    receipt: null,
    worker: null,
    result: null,
    requestedSequence: event.sequence,
    settledSequence: null,
  };
}

function withoutWaits(
  operations: EffectState["operations"],
  event: EffectEvent,
): EffectState["operations"] {
  return Object.fromEntries(
    Object.entries(operations).map(([operationId, operation]) => [
      operationId,
      operation.runId === event.runId &&
      operation.status === "waiting" &&
      operationPhase(operation.operationId) !== "command-wait"
        ? cancelledOperation(operation, {
            reason: "budget-exhausted",
            sequence: event.sequence,
          })
        : operation,
    ]),
  );
}

function admitted(effects: EffectState, context: EffectContext): EffectResult {
  const { event, runStatus } = context;
  const operationId = field(event, "operationId");
  const { reason, budget } = authorization(effects.budgets[event.runId], event);
  const budgets =
    budget === undefined
      ? effects.budgets
      : { ...effects.budgets, [event.runId]: budget };
  const remaining =
    reason === "budget-exhausted"
      ? withoutWaits(effects.operations, event)
      : effects.operations;
  const operation =
    reason === null
      ? requestedOperation(event, {
          status: "waiting",
          reason: waitReason(effects, {
            leaseKey: leaseKeyOf(event),
            runStatus,
          }),
          waitSequence: event.sequence,
        })
      : requestedOperation(event, {
          status: "refused",
          reason,
          waitSequence: null,
        });
  return {
    kind: "changed",
    effects: withOperation(
      { ...effects, budgets, operations: remaining },
      operation,
    ),
    disposition: {
      operationId,
      disposition: reason === null ? "admitted" : "refused",
      reason,
    },
  };
}

export function requested(
  effects: EffectState,
  context: EffectContext,
): EffectResult {
  const refused = refusal(context);
  if (refused !== undefined) return rejected(refused);
  const { event } = context;
  const operationId = field(event, "operationId");
  const existing = effects.operations[operationId];
  if (existing !== undefined)
    return equalInput(existing, event)
      ? {
          kind: "changed",
          effects,
          disposition: { operationId, disposition: "existing", reason: null },
        }
      : rejected("changed-operation-input");
  const denied = denial(effects, event);
  if (denied === undefined) return admitted(effects, context);
  return {
    kind: "changed",
    effects,
    disposition: { operationId, disposition: "denied", reason: denied },
  };
}

function denial(effects: EffectState, event: EffectEvent): string | undefined {
  const source = effects.operations[event.payload["source"] ?? ""];
  if (event.payload["source"] === undefined) return undefined;
  const lease =
    source?.runId === event.runId ? ownedLease(effects, source) : undefined;
  if (lease?.generation !== count(event, "sourceGeneration"))
    return "retired-lease-generation";
  return current(lease, event) ? undefined : "lease-expired";
}
