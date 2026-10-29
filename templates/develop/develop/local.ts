import type { CycleOutcome } from "cloving/workflows";
import {
  developReport,
  repair,
  type DevelopState,
  type DevelopFeedback,
} from "./report.ts";
import { reviewByPerson } from "cloving/workflows/steps/review-by-person";
import { partialChoice } from "./partial-choice.ts";

export async function localRound(
  state: DevelopState,
): Promise<CycleOutcome | DevelopFeedback> {
  const { input, round } = state;
  const report = await developReport(state);
  const partial = await partialChoice({ input, round, report });
  if (partial !== null) return partial;
  if (
    !report.clean ||
    report.commit === null ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(report.commit)
  )
    throw new Error("invalid-local-commit");
  const review = await reviewByPerson({
    subject: { target: input.cycleId, commit: report.commit },
  });
  if (!review.accepted)
    return repair({
      cycleId: input.cycleId,
      round,
      report,
      result: { reason: "review-changes", output: review.feedback },
    });
  return {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: `local-${report.commit}`,
    ticketStatus: report.status.kind,
  };
}
