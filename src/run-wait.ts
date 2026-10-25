import type { RunWaitOutcome, RunWaitRequest } from "./step-bridge.ts";

export interface RunWaitTarget {
  readonly parentRunId: string | null;
  readonly status: string;
  readonly endedAt: number | null;
  readonly outcome: RunWaitOutcome | null;
}

export type RunWaitResult =
  | { readonly kind: "waiting"; readonly deadline: number }
  | { readonly kind: "completed"; readonly outcome: RunWaitOutcome }
  | { readonly kind: "refused"; readonly reason: string };

function validSeconds(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400;
}

export function runWaitResult(
  request: RunWaitRequest,
  context: {
    readonly callerRunId: string;
    readonly startedAt: number;
    readonly now: number;
    readonly target: RunWaitTarget | undefined;
  },
): RunWaitResult {
  const { target, callerRunId, startedAt, now } = context;
  const seconds = request.maximumWaitSeconds;
  if (
    !validSeconds(seconds) ||
    target?.parentRunId !== callerRunId ||
    request.runId === callerRunId
  )
    return { kind: "refused", reason: "run-wait-refused" };
  const deadline = startedAt + seconds * 1000;
  if (
    ["completed", "failed", "cancelled"].includes(target.status) &&
    target.outcome !== null &&
    target.endedAt !== null &&
    target.endedAt <= deadline
  )
    return { kind: "completed", outcome: target.outcome };
  if (now >= deadline) return { kind: "refused", reason: "run-wait-timeout" };
  return { kind: "waiting", deadline };
}
