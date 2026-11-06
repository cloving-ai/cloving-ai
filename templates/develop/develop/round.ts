import type { CycleOutcome, PullRequest } from "cloving/workflows";
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";
import { acceptWork } from "./accept.ts";
import { developReport } from "./report.ts";
import {
  type DevelopState,
  type DevelopFeedback,
  type RoundResult,
} from "./report.ts";
import { openPull, finishPull } from "./pull.ts";
import { recover, retryMerge } from "./recovery.ts";

export async function developRound(
  state: DevelopState,
): Promise<CycleOutcome | DevelopFeedback> {
  const { input, round } = state;
  const report = await developReport(state);
  if ("kind" in report) return report;
  const pull = await openPull({ input, round });
  if ("kind" in pull) return pull;
  const result = await deliverPull({ round, pull });
  if ("kind" in result) return result;
  if (result.merged) return await finishPull({ input, round, report, pull });
  return await recover({ state, report, pull, result });
}

export async function deliverPull(request: {
  readonly round: number;
  readonly pull: PullRequest;
}): Promise<RoundResult | CycleOutcome> {
  const { round, pull } = request;
  const review = await acceptWork({
    target: pull.target,
    number: pull.number,
    commit: pull.commit,
  });
  if (!review.accepted)
    return {
      merged: false,
      reason: "review-changes",
      output: review.feedback,
      findings: review.findings,
    };
  try {
    return await mergeWhenGreen({
      pull: pull,
      check: "beforeMerge",
      round: round,
    });
  } catch (error) {
    return await retryMerge({ pull, round, error });
  }
}
