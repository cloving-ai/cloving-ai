import type { CycleOutcome } from "cloving/workflows";
import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";
import { developTurn } from "./turn.ts";
import {
  reportOf,
  repair,
  type DevelopTask,
  type DevelopFeedback,
} from "./report.ts";
import { openPull, finishPull, labelTicket } from "./pull.ts";

export async function developRound(state: {
  readonly input: DevelopTask;
  readonly round: number;
  readonly feedback: DevelopFeedback | null;
}): Promise<CycleOutcome | DevelopFeedback> {
  const { input, round, feedback } = state;
  try {
    const report = reportOf(
      await developTurn({
        cycleId: input.cycleId,
        repository: input.repository,
        ticket: input.ticket,
        round,
        feedback,
      }),
    );
    const pull = await openPull({ input, round });
    const subject = {
      target: pull.target,
      number: pull.number,
      commit: pull.commit,
    };
    const review = await reviewByAgent({
      subject: subject,
      reviewer: { kind: "greptile" },
    });
    const result = review.accepted
      ? await mergeWhenGreen({ pull: pull, check: "beforeMerge", round: round })
      : { merged: false, reason: "review-changes", output: review.feedback };
    if (result.merged) return await finishPull({ input, round, report, pull });
    return repair({ cycleId: input.cycleId, round, report, result });
  } catch (error) {
    await labelTicket(input, { key: "blocked", round });
    throw error;
  }
}
