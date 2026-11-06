import type { CycleOutcome } from "cloving/workflows";
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";
import { acceptWork } from "./accept.ts";
import { finishRescue, pushPull } from "./pull.ts";
import type { RescueTask } from "./input.ts";
import type { RescueTree } from "./prepare.ts";
import { rescueTurn, type RescueFeedback, type RescueState } from "./turn.ts";

export type RescueStep = CycleOutcome | RescueFeedback;

export interface RescueRequest {
  readonly task: RescueTask;
  readonly tree: RescueTree;
  readonly round: number;
  readonly last: RescueStep;
}

const waitReasons = [
  "ci-pending",
  "check-not-configured",
  "merge-queue-removed",
  "merge-queue-timeout",
];

function repair(
  state: RescueState,
  result: { readonly reason: string | null; readonly output: string },
): RescueStep {
  const reason = result.reason ?? "merge-failed";
  const needsAnswer = reason === "review-changes" || reason === "not-approved";
  if (
    waitReasons.includes(reason) ||
    (needsAnswer && result.output.trim() === "")
  )
    return {
      kind: "blocked",
      cycleId: state.task.cycleId,
      reason,
      evidenceId: reason === "review-changes" ? "review" : "merge",
    };
  return { reason, output: result.output };
}

export async function rescueRound(request: RescueRequest): Promise<RescueStep> {
  const { task, tree, round, last } = request;
  if ("kind" in last) return last;
  const state: RescueState = { task, tree, round, feedback: last };
  await rescueTurn(state);
  const pull = await pushPull(state);
  const review = await acceptWork({
    target: pull.target,
    number: pull.number,
    commit: pull.commit,
  });
  if (!review.accepted)
    return repair(state, { reason: "review-changes", output: review.feedback });
  const merge = await mergeWhenGreen({
    pull: pull,
    check: "beforeMerge",
    round: state.round,
  });
  if (!merge.merged) return repair(state, merge);
  return await finishRescue({
    task: state.task,
    round: state.round,
    pull: pull,
  });
}
