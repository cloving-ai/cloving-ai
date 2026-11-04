import { sleep } from "workflow";
import type { RunWaitOutcome, RunWaitRequest } from "../step-bridge.ts";
import { checkRunWait, runWaitDate } from "./run-wait.ts";

export async function waitForRun(
  request: RunWaitRequest,
): Promise<RunWaitOutcome> {
  let progress = await checkRunWait({
    runId: request.runId,
    maximumWaitSeconds: request.maximumWaitSeconds,
  });
  while (progress.kind === "waiting") {
    await sleep(runWaitDate(progress.nextCheckAt));
    progress = await checkRunWait({
      runId: request.runId,
      maximumWaitSeconds: request.maximumWaitSeconds,
      startedAt: progress.startedAt,
    });
  }
  return progress.outcome;
}
