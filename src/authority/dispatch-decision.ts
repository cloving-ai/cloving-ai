import type { CommandWaitState } from "./command-waits.ts";
import { operationPhase } from "../operation-identity.ts";
import { instantMilliseconds } from "./instants.ts";
import { authorizeEffect } from "../effect-authorization.ts";
import { isAfter } from "./instants.ts";

export interface DispatchRead {
  readonly commandWait?: {
    readonly wait: CommandWaitState;
    readonly declared: boolean;
  };
  readonly attempt:
    | {
        readonly outcome: string | null;
        readonly inputDigest: string;
        readonly leaseGeneration: number | null;
      }
    | undefined;
  readonly released: boolean;
  readonly runStatus: string;
  readonly workflow: string;
  readonly pinned: boolean;
  readonly operation:
    | {
        readonly status: string;
        readonly capability: string;
        readonly units: number;
        readonly method?: string;
        readonly target?: string;
        readonly payload?: string;
      }
    | undefined;
  readonly budget:
    | {
        readonly limit: number;
        readonly spent: number;
        readonly capabilities: readonly string[];
        readonly exhaustedSequence: number | null;
      }
    | undefined;
  readonly lease:
    | {
        readonly operationId: string;
        readonly generation: number;
        readonly expiresAt: string;
        readonly state: string;
      }
    | undefined;
}

export interface DispatchCheck {
  readonly intent: {
    readonly operationId: string;
    readonly inputDigest: string;
    readonly computedDigest: string;
    readonly workflow: string;
    readonly leaseGeneration?: number;
  };
  readonly now: string;
  readonly mode?: "retry";
}

export type DispatchDecision =
  "stale" | "withheld" | "refused" | "blocked" | "send";

function bound(read: DispatchRead, intent: DispatchCheck["intent"]): boolean {
  const { attempt, lease, operation } = read;
  if (attempt === undefined || lease === undefined || operation === undefined)
    return false;
  return [
    attempt.outcome === null,
    attempt.inputDigest === intent.inputDigest,
    intent.computedDigest === intent.inputDigest,
    read.workflow === intent.workflow,
    attempt.leaseGeneration === lease.generation,
    intent.leaseGeneration === lease.generation,
    lease.operationId === intent.operationId,
    lease.state !== "released",
  ].every(Boolean);
}

function sendable(read: DispatchRead, check: DispatchCheck): boolean {
  const statuses =
    check.mode === "retry"
      ? ["dispatch-pending", "recovering", "blocked"]
      : ["dispatch-pending"];
  return [
    !read.released,
    read.runStatus === "running",
    statuses.includes(read.operation?.status ?? ""),
    read.lease?.state === "held",
    isAfter(read.lease?.expiresAt ?? "", check.now),
  ].every(Boolean);
}

function authorized(read: DispatchRead): boolean {
  const { budget, operation } = read;
  if (budget === undefined || operation === undefined) return false;
  if (budget.exhaustedSequence !== null) return false;
  const result = authorizeEffect(
    { capabilities: budget.capabilities },
    {
      budget: { limit: budget.limit, spent: budget.spent - operation.units },
      request: { capability: operation.capability, units: operation.units },
    },
  );
  return result.kind === "authorized";
}

function authorizedWait(read: DispatchRead, check: DispatchCheck): boolean {
  const { commandWait, operation } = read;
  if (commandWait === undefined || operation === undefined) return false;
  const { wait, declared } = commandWait;
  const now = instantMilliseconds(check.now);
  return [
    declared,
    wait.state === "waiting",
    wait.checkOperation === check.intent.operationId,
    wait.nextCheckAt !== null && now >= wait.nextCheckAt,
    now < wait.deadline,
    read.budget?.capabilities.includes("command"),
    operation.capability === "command",
    operation.units === 1,
    operation.method === `run:${wait.command}`,
    operation.target === wait.command,
    operation.payload === wait.inputDigest,
  ].every(Boolean);
}

export function dispatchDecision(
  read: DispatchRead,
  check: DispatchCheck,
): DispatchDecision {
  if (!bound(read, check.intent)) return "stale";
  if (!sendable(read, check)) return "withheld";
  const allowed =
    operationPhase(check.intent.operationId) === "command-wait"
      ? authorizedWait(read, check)
      : authorized(read);
  if (!allowed) return "refused";
  return read.pinned ? "send" : "blocked";
}
