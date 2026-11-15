import { isAfter } from "./instants.ts";
import {
  count,
  field,
  isHolding,
  rejected,
  type EffectContext,
  type EffectResult,
  type EffectState,
  type Operation,
} from "./operations.ts";

export function workingQueue(effects: EffectState, runId: string): boolean {
  return (effects.workingQueues ?? effects.queueRuns).includes(runId);
}

export function computational(operation: Operation): boolean {
  return (
    operation.capability === "claude" ||
    operation.capability === "command" ||
    operation.method.startsWith("run-turn")
  );
}

export function activeQueueWork(effects: EffectState): ReadonlySet<string> {
  return new Set(
    Object.values(effects.operations)
      .filter(
        (operation) =>
          isHolding(operation) &&
          workingQueue(effects, operation.runId) &&
          (computational(operation) ||
            effects.work?.[operation.operationId] !== undefined),
      )
      .map((operation) => operation.runId),
  );
}

function ownerRefusal(
  effects: EffectState,
  context: EffectContext,
): string | undefined {
  const { event } = context;
  const operation = effects.operations[field(event, "operationId")];
  if (operation?.runId !== event.runId) return "unknown-operation";
  if (operation.capability !== "github" || operation.method !== "merge")
    return "unsupported-work-stage";
  if (operation.inputDigest !== field(event, "inputDigest"))
    return "input-mismatch";
  return leaseRefusal(effects, { ...context, operation });
}

function leaseRefusal(
  effects: EffectState,
  context: EffectContext & { readonly operation: Operation },
): string | undefined {
  const { operation, event } = context;
  const lease = effects.leases[operation.leaseKey];
  if (
    lease?.operationId !== operation.operationId ||
    lease.generation !== count(event, "leaseGeneration")
  )
    return "retired-lease-generation";
  if (lease.state !== "held" || !isAfter(lease.expiresAt, event.recordedAt))
    return "lease-expired";
  return isHolding(operation) ? undefined : "operation-settled";
}

export function workEntered(
  effects: EffectState,
  context: EffectContext,
): EffectResult {
  const refusal = ownerRefusal(effects, context);
  if (refusal !== undefined) return rejected(refusal);
  const held = runRefusal(context.runStatus);
  if (held !== undefined) return rejected(held);
  const operationId = field(context.event, "operationId");
  const generation = count(context.event, "leaseGeneration");
  if (effects.work?.[operationId]?.generation === generation)
    return rejected("work-already-entered");
  return {
    kind: "changed",
    effects: {
      ...effects,
      work: {
        ...effects.work,
        [operationId]: { generation, stageId: field(context.event, "stageId") },
      },
    },
  };
}

export function workLeft(
  effects: EffectState,
  context: EffectContext,
): EffectResult {
  const refusal = ownerRefusal(effects, context);
  if (refusal !== undefined) return rejected(refusal);
  const active = effects.work?.[field(context.event, "operationId")];
  if (
    active?.stageId !== field(context.event, "stageId") ||
    active.generation !== count(context.event, "leaseGeneration")
  )
    return rejected("stale-work-stage");
  const work = Object.fromEntries(
    Object.entries(effects.work ?? {}).filter(
      ([id]) => id !== field(context.event, "operationId"),
    ),
  );
  return { kind: "changed", effects: { ...effects, work } };
}

function runRefusal(status: string): string | undefined {
  if (["paused", "waiting_gate"].includes(status)) return "run-work-held";
  return status === "running" ? undefined : "run-not-running";
}

export function replayedWorkRefusal(
  effects: EffectState,
  context: {
    readonly command: Readonly<Record<string, unknown>>;
    readonly recordedAt: string;
    readonly runStatus: string;
  },
): string | undefined {
  const { command, recordedAt, runStatus } = context;
  if (command["kind"] !== "enter-operation-work") return undefined;
  const payload = Object.fromEntries(
    Object.entries(command).map(([key, value]) => [key, String(value)]),
  );
  const event = {
    sequence: 0,
    runId: String(command["runId"]),
    recordedAt,
    payload,
  };
  const refusal =
    ownerRefusal(effects, { event, runStatus }) ?? runRefusal(runStatus);
  if (refusal !== undefined) return refusal;
  const active = effects.work?.[field(event, "operationId")];
  if (active === undefined) return "work-stage-released";
  return active.stageId === field(event, "stageId") &&
    active.generation === count(event, "leaseGeneration")
    ? undefined
    : "stale-work-stage";
}

export function workCapacityRefusal(
  effects: EffectState,
  change: {
    readonly command: Readonly<Record<string, unknown>>;
    readonly limit?: number;
  },
): string | undefined {
  const { command, limit } = change;
  if (
    command["kind"] !== "enter-operation-work" ||
    limit === undefined ||
    !workingQueue(effects, String(command["runId"]))
  )
    return undefined;
  const working = activeQueueWork(effects);
  return working.has(String(command["runId"])) || working.size < limit
    ? undefined
    : "queue-working-capacity-exceeded";
}
