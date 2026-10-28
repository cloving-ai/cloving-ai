import type { CycleOutcome } from "cloving/workflows";
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";
import { acceptWork } from "./accept.ts";
import { developReport } from "./report.ts";
import { repair, type DevelopTask, type DevelopFeedback } from "./report.ts";
import { openPull, finishPull, labelTicket } from "./pull.ts";

export async function developRound(state: {
  readonly input: DevelopTask;
  readonly round: number;
  readonly feedback: DevelopFeedback | null;
}): Promise<CycleOutcome | DevelopFeedback> {
  const { input, round } = state;
  try {
    const report = await developReport(state);
    const pull = await openPull({ input, round });
    const subject = {
      target: pull.target,
      number: pull.number,
      commit: pull.commit,
    };
    const review = await acceptWork(subject);
    const result = review.accepted
      ? await mergeWhenGreen({ pull: pull, check: "beforeMerge", round: round })
      : { merged: false, reason: "review-changes", output: review.feedback };
    if (result.merged) return await finishPull({ input, round, report, pull });
    return repair({ cycleId: input.cycleId, round, report, result });
  } catch (error) {
    try {
      await labelTicket(input, { key: "blocked", round });
    } catch (labelError) {
      throw new AggregateError(
        [error, labelError],
        "development-and-label-failed",
        { cause: labelError },
      );
    }
    throw error;
  }
}
