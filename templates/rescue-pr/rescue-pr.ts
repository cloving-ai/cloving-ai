import type { CycleOutcome } from "cloving/workflows";
import { rescueTask, type RescueInput } from "./rescue-pr/input.ts";
import { prepareRescue } from "./rescue-pr/prepare.ts";
import { rescueRound, type RescueStep } from "./rescue-pr/round.ts";

function blocked(request: RescueInput, reason: string): CycleOutcome {
  return {
    kind: "blocked",
    cycleId: request.cycleId,
    reason: reason,
    evidenceId: "rescue",
  };
}

function failureReason(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
    ? error.message
    : "rescue-failed";
}

export async function rescuePr(request: RescueInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    const task = rescueTask(request);
    const tree = await prepareRescue(task);
    let last: RescueStep = { reason: task.reason, output: "" };
    for (let round = 1; round <= 4; round += 1) {
      last = await rescueRound({ task, tree, round, last });
    }
    return "kind" in last ? last : blocked(request, last.reason);
  } catch (error) {
    return blocked(request, failureReason(error));
  }
}
