import { operationPhase } from "../operation-identity.ts";
import { current, ownedLease } from "./leases.ts";
import {
  cancelledOperation,
  count,
  field,
  isFinal,
  isHolding,
  namesRunIntent,
  rejected,
  withOperation,
  type Disposition,
  type EffectContext,
  type EffectEvent,
  type EffectResult,
  type EffectState,
  type Operation,
  type OperationStatus,
} from "./operations.ts";

const terminalStatuses = ["completed", "failed", "cancelled"];

interface Subject extends EffectContext {
  readonly operation: Operation;
}

function disposition(operation: Operation, reason: string | null): Disposition {
  return {
    operationId: operation.operationId,
    disposition: reason === null ? "applied" : "rejected",
    reason,
  };
}

function released(effects: EffectState, operation: Operation): EffectState {
  const lease = ownedLease(effects, operation);
  return {
    ...effects,
    leases:
      lease === undefined
        ? effects.leases
        : {
            ...effects.leases,
            [lease.resourceKey]: { ...lease, state: "released" },
          },
    holding: effects.holding - (isHolding(operation) ? 1 : 0),
  };
}

function settled(
  effects: EffectState,
  settlement: Subject & { readonly status: OperationStatus },
): EffectResult {
  const { operation, event, status } = settlement;
  return {
    kind: "changed",
    effects: withOperation(released(effects, operation), {
      ...operation,
      status,
      receipt: operation.receipt ?? event.payload["receipt"] ?? null,
      worker: operation.worker ?? event.payload["worker"] ?? null,
      reason: event.payload["reason"] ?? null,
      result: event.payload["result"] ?? null,
      waitSequence: null,
      settledSequence: event.sequence,
    }),
    released: [operation.operationId],
    disposition: disposition(operation, null),
  };
}

function reportRefusal(
  effects: EffectState,
  subject: Subject,
): string | undefined {
  const { operation, event } = subject;
  if (operation.inputDigest !== field(event, "inputDigest"))
    return "input-mismatch";
  if (isFinal(operation)) return "operation-settled";
  const lease = ownedLease(effects, operation);
  if (lease?.generation !== count(event, "leaseGeneration"))
    return "retired-lease-generation";
  if (!current(lease, event)) return "lease-expired";
  if (operation.worker === null) return "acceptance-not-recorded";
  if (operation.worker !== field(event, "worker")) return "worker-mismatch";
  return undefined;
}

const reportedStatuses: Readonly<Record<string, OperationStatus>> = {
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
};

export function reported(
  effects: EffectState,
  context: EffectContext,
): EffectResult {
  const { event } = context;
  const operation = effects.operations[field(event, "operationId")];
  if (operation?.runId !== event.runId) return rejected("unknown-operation");
  const refusal = reportRefusal(effects, { ...context, operation });
  if (refusal !== undefined)
    return {
      kind: "changed",
      effects,
      disposition: disposition(operation, refusal),
    };
  return settled(effects, {
    ...context,
    operation,
    status: reportedStatuses[field(event, "outcome")] ?? "failed",
  });
}

function formRefusal(subject: Subject): string | undefined {
  const { operation, event } = subject;
  const outcome = field(event, "outcome");
  if (outcome === "not-started" && operation.receipt !== null)
    return "acceptance-recorded";
  const identified =
    event.payload["receipt"] !== undefined &&
    event.payload["worker"] !== undefined;
  return outcome === "accepted" && !identified ? "invalid-outcome" : undefined;
}

function outcomeRefusal(
  effects: EffectState,
  subject: Subject,
): string | undefined {
  const { operation, event } = subject;
  if (isFinal(operation)) return "operation-settled";
  if (
    ownedLease(effects, operation)?.generation !==
    count(event, "leaseGeneration")
  )
    return "retired-lease-generation";
  const worker = event.payload["worker"];
  const bound = operation.worker ?? worker;
  if (worker !== undefined && worker !== bound) return "worker-mismatch";
  return formRefusal(subject);
}

function counted(operation: Operation): Operation {
  const attempts = operation.attempts + 1;
  if (attempts < operation.recoveryLimit) return { ...operation, attempts };
  return {
    ...operation,
    attempts,
    status: "blocked",
    reason: "outcome-unknown",
  };
}

function accepted(effects: EffectState, subject: Subject): EffectResult {
  const { operation, event } = subject;
  const lease = ownedLease(effects, operation);
  const live = lease !== undefined && current(lease, event);
  return {
    kind: "changed",
    effects: withOperation(effects, {
      ...operation,
      receipt: operation.receipt ?? field(event, "receipt"),
      worker: operation.worker ?? field(event, "worker"),
      status: live ? "running" : "recovering",
      reason: live ? null : "lease-expired",
    }),
    released: [operation.operationId],
    disposition: disposition(operation, null),
  };
}

function statedReason(event: EffectEvent): string {
  const stated = field(event, "reason");
  return stated === "" ? "not-started" : stated;
}

function notStarted(effects: EffectState, subject: Subject): EffectResult {
  const { operation, event, runStatus } = subject;
  const exhausted =
    field(event, "reason") === "budget-exhausted" ||
    (operationPhase(operation.operationId) !== "command-wait" &&
      (effects.budgets[operation.runId]?.exhaustedSequence ?? null) !== null);
  const ended = terminalStatuses.includes(runStatus);
  const waiting: Operation = {
    ...operation,
    status: "waiting",
    reason: runStatus === "running" ? "ready" : "run-not-running",
    waitSequence: event.sequence,
  };
  const cancelled = cancelledOperation(operation, {
    reason: exhausted ? "budget-exhausted" : statedReason(event),
    sequence: event.sequence,
  });
  const final = ended || exhausted;
  return {
    kind: "changed",
    effects: withOperation(
      released(effects, operation),
      final ? cancelled : waiting,
    ),
    ...(final ? { released: [operation.operationId] } : {}),
    disposition: disposition(operation, null),
  };
}

function unknown(effects: EffectState, subject: Subject): EffectResult {
  const { operation } = subject;
  const attempted = counted(operation);
  return {
    kind: "changed",
    effects: withOperation(effects, {
      ...attempted,
      status: attempted.status === "blocked" ? "blocked" : "recovering",
      reason: "outcome-unknown",
    }),
    disposition: disposition(operation, null),
  };
}

type Outcome = (effects: EffectState, subject: Subject) => EffectResult;

function final(status: OperationStatus): Outcome {
  return (effects, subject) => settled(effects, { ...subject, status });
}

const outcomes: Readonly<Record<string, Outcome>> = {
  accepted,
  "not-started": notStarted,
  unknown,
  completed: final("completed"),
  failed: final("failed"),
  stopped: final("stopped"),
};

function stoppedIntent(effects: EffectState, event: EffectEvent): EffectResult {
  const operationId = field(event, "operationId");
  const known =
    field(event, "outcome") === "stopped" &&
    namesRunIntent(operationId, event.runId);
  if (!known) return rejected("unknown-operation");
  return {
    kind: "changed",
    effects: {
      ...effects,
      stops: {
        ...effects.stops,
        [operationId]: { runId: event.runId, sequence: event.sequence },
      },
    },
    disposition: { operationId, disposition: "applied", reason: null },
  };
}

export function stopReported(
  effects: EffectState,
  event: EffectEvent,
): EffectState {
  const operationId = event.payload["operationId"];
  const named =
    field(event, "condition") === "stopped" &&
    operationId !== undefined &&
    namesRunIntent(operationId, event.runId);
  if (!named) return effects;
  return {
    ...effects,
    stops: {
      ...effects.stops,
      [operationId]: { runId: event.runId, sequence: event.sequence },
    },
  };
}

export function reconciled(
  effects: EffectState,
  context: EffectContext,
): EffectResult {
  const { event } = context;
  const operation = effects.operations[field(event, "operationId")];
  if (operation === undefined) return stoppedIntent(effects, event);
  if (operation.runId !== event.runId) return rejected("unknown-operation");
  const subject = { ...context, operation };
  const refusal = outcomeRefusal(effects, subject);
  const apply = outcomes[field(event, "outcome")];
  if (refusal === undefined && apply !== undefined)
    return apply(effects, subject);
  const reason = refusal ?? "invalid-outcome";
  return {
    kind: "changed",
    effects: isHolding(operation)
      ? withOperation(effects, counted(operation))
      : effects,
    disposition: disposition(operation, reason),
  };
}
