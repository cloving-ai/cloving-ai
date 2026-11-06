import type { CycleOutcome } from "cloving/workflows";
import { rescueTask, type RescueInput } from "./rescue-pr/input.ts";
import { prepareRescue } from "./rescue-pr/prepare.ts";
import { rescueRound } from "./rescue-pr/round.ts";
import type { RescueFeedback } from "./rescue-pr/turn.ts";

function failureReason(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
    ? error.message
    : "rescue-failed";
}

export async function rescuePr(request: RescueInput): Promise<CycleOutcome> {
  "use workflow";
  let outcome: CycleOutcome | null = null;
  let reason: string;
  try {
    const task = rescueTask(request);
    const tree = await prepareRescue(task);
    let feedback: RescueFeedback = { reason: task.reason, output: "" };
    for (let round = 1; round <= 4; round += 1) {
      if (outcome === null) {
        const next = await rescueRound({ task, tree, round, feedback });
        outcome = "kind" in next ? next : null;
        feedback = "kind" in next ? feedback : next;
      }
    }
    reason = feedback.reason;
  } catch (error) {
    reason = failureReason(error);
  }
  return (
    outcome ?? {
      kind: "blocked",
      cycleId: request.cycleId,
      reason: reason,
      evidenceId: "rescue",
    }
  );
}
