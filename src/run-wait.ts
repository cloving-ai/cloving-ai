import type {
  RunWaitCheck,
  RunWaitOutcome,
  RunWaitProgress,
} from "./step-bridge.ts";

export interface RunWaitTarget {
  readonly parentRunId: string | null;
  readonly status: string;
  readonly endedAt: number | null;
  readonly outcome: RunWaitOutcome | null;
}

export interface RunWaitChecks {
  readonly firstMilliseconds: number;
  readonly maximumMilliseconds: number;
}

export const runWaitChecks: RunWaitChecks = {
  firstMilliseconds: 2000,
  maximumMilliseconds: 60000,
};

export type RunWaitResult =
  RunWaitProgress | { readonly kind: "refused"; readonly reason: string };

interface RunWaitContext {
  readonly callerRunId: string;
  readonly stepStartedAt: number;
  readonly now: number;
  readonly target: RunWaitTarget | undefined;
  readonly checks?: RunWaitChecks | undefined;
}

function validSeconds(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400;
}

function validStart(startedAt: number): boolean {
  return Number.isSafeInteger(startedAt) && startedAt >= 0;
}

function awaitable(request: RunWaitCheck, context: RunWaitContext): boolean {
  const { target, callerRunId, stepStartedAt } = context;
  return (
    validSeconds(request.maximumWaitSeconds) &&
    validStart(request.startedAt ?? stepStartedAt) &&
    target?.parentRunId === callerRunId &&
    request.runId !== callerRunId
  );
}

export function runWaitCheckAt(
  wait: {
    readonly startedAt: number;
    readonly deadline: number;
    readonly now: number;
  },
  checks: RunWaitChecks = runWaitChecks,
): number {
  const interval = Math.min(
    checks.maximumMilliseconds,
    Math.max(checks.firstMilliseconds, wait.now - wait.startedAt),
  );
  return Math.min(wait.deadline, wait.now + interval);
}

export function runWaitResult(
  request: RunWaitCheck,
  context: RunWaitContext,
): RunWaitResult {
  const { target, now } = context;
  if (target === undefined || !awaitable(request, context))
    return { kind: "refused", reason: "run-wait-refused" };
  const startedAt = Math.min(
    request.startedAt ?? context.stepStartedAt,
    context.stepStartedAt,
  );
  const deadline = startedAt + request.maximumWaitSeconds * 1000;
  if (
    ["completed", "failed", "cancelled"].includes(target.status) &&
    target.outcome !== null &&
    target.endedAt !== null &&
    target.endedAt <= deadline
  )
    return { kind: "completed", outcome: target.outcome };
  if (now >= deadline) return { kind: "refused", reason: "run-wait-timeout" };
  return {
    kind: "waiting",
    startedAt,
    deadline,
    nextCheckAt: runWaitCheckAt({ startedAt, deadline, now }, context.checks),
  };
}
