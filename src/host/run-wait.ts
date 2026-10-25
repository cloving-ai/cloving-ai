import { FatalError, RetryableError } from "workflow";
import { runWaitResult, type RunWaitTarget } from "../run-wait.ts";
import type { RunWaitOutcome, RunWaitRequest } from "../step-bridge.ts";

export interface RunWaitPorts {
  readonly now?: () => number;
  readonly target: (runId: string) => Promise<RunWaitTarget | undefined>;
  readonly observe: (report: {
    readonly runId: string;
    readonly commandId: string;
    readonly condition: string;
    readonly reason: string;
    readonly evidence?: string;
    readonly retryAt?: string;
    readonly operationId?: string;
  }) => Promise<{ readonly kind: string; readonly reason?: string }>;
}

export async function runWait(
  ports: RunWaitPorts,
  wait: {
    readonly caller: {
      readonly runId: string;
      readonly stepId: string;
      readonly startedAt: number;
    };
    readonly request: RunWaitRequest;
  },
): Promise<RunWaitOutcome> {
  const { caller, request } = wait;
  const now = (ports.now ?? Date.now)();
  const result = runWaitResult(request, {
    callerRunId: caller.runId,
    startedAt: caller.startedAt,
    now,
    target: await ports.target(request.runId),
  });
  const waiting = result.kind === "waiting";
  const receipt = await ports.observe({
    runId: caller.runId,
    commandId: `${caller.stepId}:run-wait:${waiting ? "waiting" : "ended"}`,
    condition: waiting ? "waiting-run" : "working",
    reason: waiting ? "awaiting-run" : "in-progress",
    operationId: caller.stepId,
    ...(result.kind !== "waiting"
      ? {}
      : {
          evidence: request.runId,
          retryAt: new Date(result.deadline).toISOString(),
        }),
  });
  if (!["accepted", "duplicate"].includes(receipt.kind))
    throw new RetryableError("run-wait-observation-unavailable", {
      retryAfter: 1000,
    });
  if (result.kind === "refused") throw new FatalError(result.reason);
  if (result.kind === "completed") return result.outcome;
  throw new RetryableError("awaiting-run", {
    retryAfter: Math.max(1, Math.min(1000, result.deadline - now)),
  });
}
