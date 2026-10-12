import { isAfter, notBefore } from "./instants.ts";
import {
  count,
  field,
  rejected,
  withOperation,
  type EffectContext,
  type EffectResult,
  type EffectState,
  type Lease,
  type Operation,
} from "./operations.ts";

export function ownedLease(
  effects: EffectState,
  operation: Operation,
): Lease | undefined {
  const lease = effects.leases[operation.leaseKey];
  const owned =
    lease?.operationId === operation.operationId && lease.state !== "released";
  return owned ? lease : undefined;
}

export function current(
  lease: Lease,
  event: { readonly recordedAt: string },
): boolean {
  return (
    lease.state === "held" && !notBefore(event.recordedAt, lease.expiresAt)
  );
}

function grantRefusal(
  effects: EffectState,
  grant: EffectContext & { readonly operation: Operation },
): string | undefined {
  const { operation, event, runStatus } = grant;
  if (operation.status !== "waiting") return "operation-not-waiting";
  if (runStatus !== "running") return "run-not-running";
  const lease = effects.leases[operation.leaseKey];
  if (lease !== undefined && lease.state !== "released") return "resource-held";
  if (count(event, "leaseGeneration") !== (lease?.generation ?? 0) + 1)
    return "stale-lease-generation";
  if (effects.holding >= count(event, "capacity")) return "capacity-exceeded";
  if (!isAfter(field(event, "expiresAt"), event.recordedAt))
    return "invalid-lease-expiry";
  return undefined;
}

export function granted(
  effects: EffectState,
  context: EffectContext,
): EffectResult {
  const { event } = context;
  const operation = effects.operations[field(event, "operationId")];
  if (operation?.runId !== event.runId) return rejected("unknown-operation");
  const refusal = grantRefusal(effects, { ...context, operation });
  if (refusal !== undefined) return rejected(refusal);
  const lease: Lease = {
    resourceKey: operation.leaseKey,
    operationId: operation.operationId,
    generation: count(event, "leaseGeneration"),
    expiresAt: field(event, "expiresAt"),
    state: "held",
    grantedSequence: event.sequence,
  };
  return {
    kind: "changed",
    effects: {
      ...withOperation(effects, {
        ...operation,
        status: "dispatch-pending",
        reason: null,
        waitSequence: null,
      }),
      leases: { ...effects.leases, [lease.resourceKey]: lease },
      holding: effects.holding + 1,
    },
    added: [operation.operationId],
  };
}

function expiryRefusal(
  lease: Lease | undefined,
  expiry: EffectContext & { readonly operation: Operation },
): string | undefined {
  const { operation, event } = expiry;
  const held =
    lease?.operationId === operation.operationId && lease.state === "held";
  if (!held) return "lease-not-held";
  if (lease.generation !== count(event, "leaseGeneration"))
    return "stale-lease-generation";
  if (!notBefore(event.recordedAt, lease.expiresAt)) return "lease-not-expired";
  return undefined;
}

const expiring = ["dispatch-pending", "running"];

export function expired(
  effects: EffectState,
  context: EffectContext,
): EffectResult {
  const { event } = context;
  const operation = effects.operations[field(event, "operationId")];
  if (operation?.runId !== event.runId) return rejected("unknown-operation");
  const lease = effects.leases[operation.leaseKey];
  const refusal = expiryRefusal(lease, { ...context, operation });
  if (refusal !== undefined || lease === undefined)
    return rejected(refusal ?? "lease-not-held");
  const recovering: Operation = expiring.includes(operation.status)
    ? { ...operation, status: "recovering", reason: "lease-expired" }
    : operation;
  return {
    kind: "changed",
    effects: {
      ...withOperation(effects, recovering),
      leases: {
        ...effects.leases,
        [lease.resourceKey]: { ...lease, state: "expired" },
      },
    },
  };
}

interface Promotable {
  readonly effects: EffectState;
  readonly runs: Readonly<Record<string, { readonly status: string }>>;
}

function free(effects: EffectState, leaseKey: string): boolean {
  const lease = effects.leases[leaseKey];
  return lease === undefined || lease.state === "released";
}

export function promotions(
  state: Promotable,
  bound: number,
): readonly Operation[] {
  const { effects, runs } = state;
  const waiting = Object.values(effects.operations)
    .filter(
      (operation) =>
        operation.status === "waiting" &&
        runs[operation.runId]?.status === "running" &&
        free(effects, operation.leaseKey),
    )
    .sort(
      (left, right) =>
        (left.waitSequence ?? 0) - (right.waitSequence ?? 0) ||
        (left.operationId < right.operationId ? -1 : 1),
    );
  const keys = new Set<string>();
  const oldest = waiting.filter((operation) => {
    const first = !keys.has(operation.leaseKey);
    keys.add(operation.leaseKey);
    return first;
  });
  return oldest.slice(0, Math.max(0, bound - effects.holding));
}
