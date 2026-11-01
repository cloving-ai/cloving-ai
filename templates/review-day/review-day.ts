import type { CycleOutcome } from "cloving/workflows";
import { reviewFacts, type ReviewInput } from "./review-day/facts.ts";
import { reviewTurn } from "./review-day/turn.ts";
import { renderReport } from "./review-day/report.ts";
import { postAfterPrivacy as postReport } from "./review-day/post.ts";
import { enforceCritique } from "./review-day/critique.ts";
import { chooseProposal } from "./review-day/decision.ts";
import { handoffProposal as nextProposal } from "./review-day/next.ts";

export async function reviewDay(input: ReviewInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    const facts = await reviewFacts();
    const draft = await reviewTurn(input, {
      phase: "analyze",
      facts,
      draft: null,
    });
    const critique = await reviewTurn(input, {
      phase: "critique",
      facts,
      draft,
    });
    const report = enforceCritique(draft, { critique, facts });
    const text = renderReport(report);
    await postReport(input, text);
    const proposal = await chooseProposal(input, report.proposals);
    if (proposal !== null) await nextProposal(input, proposal);
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "review-day",
      report: text,
    };
  } catch (error) {
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "review-day",
      reason:
        error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
          ? error.message
          : "review-failed",
    };
  }
}
