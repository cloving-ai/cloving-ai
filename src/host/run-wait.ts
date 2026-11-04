import { createHash } from "node:crypto";
import { FatalError, RetryableError } from "workflow";
import {
  runWaitResult,
  type RunWaitChecks,
  type RunWaitTarget,
} from "../run-wait.ts";
import type { RunWaitCheck, RunWaitProgress } from "../step-bridge.ts";

interface RunWaitReport {
  readonly runId: string;
  readonly commandId: string;
  readonly condition: string;
  readonly reason: string;
  readonly evidence?: string;
  readonly retryAt?: string;
  readonly operationId?: string;
}

export interface RunWaitPorts {
  readonly now?: () => number;
  readonly target: (runId: string) => Promise<RunWaitTarget | undefined>;
  readonly observe: (
    report: RunWaitReport,
  ) => Promise<{ readonly kind: string; readonly reason?: string }>;
}

interface RunWaitCaller {
  readonly runId: string;
  readonly stepId: string;
  readonly stepStartedAt: number;
}

const recorded = ["accepted", "duplicate"];

function waitingReport(
  caller: RunWaitCaller,
  wait: {
    readonly request: RunWaitCheck;
    readonly startedAt: number;
    readonly deadline: number;
  },
): RunWaitReport {
  const { request, startedAt, deadline } = wait;
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        caller.runId,
        request.runId,
        request.maximumWaitSeconds,
        startedAt,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const operationId = `run-wait:${identity}`;
  return {
    runId: caller.runId,
    commandId: `${operationId}:waiting`,
    condition: "waiting-run",
    reason: "awaiting-run",
    operationId,
    evidence: request.runId,
    retryAt: new Date(deadline).toISOString(),
  };
}

export async function runWait(
  ports: RunWaitPorts,
  wait: {
    readonly caller: RunWaitCaller;
    readonly request: RunWaitCheck;
    readonly checks?: RunWaitChecks | undefined;
  },
): Promise<RunWaitProgress> {
  const { caller, request } = wait;
  const result = runWaitResult(request, {
    callerRunId: caller.runId,
    stepStartedAt: caller.stepStartedAt,
    now: (ports.now ?? Date.now)(),
    target: await ports.target(request.runId),
    checks: wait.checks,
  });
  if (result.kind === "waiting") {
    await ports.observe(waitingReport(caller, { ...result, request }));
    return result;
  }
  const receipt = await ports.observe({
    runId: caller.runId,
    commandId: `${caller.stepId}:run-wait:ended`,
    condition: "working",
    reason: "in-progress",
    operationId: caller.stepId,
  });
  if (!recorded.includes(receipt.kind))
    throw new RetryableError("run-wait-observation-unavailable", {
      retryAfter: 1000,
    });
  if (result.kind === "refused") throw new FatalError(result.reason);
  return result;
}
