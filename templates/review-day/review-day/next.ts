import { handoff } from "cloving/workflows/steps/handoff";
import { waitForRun } from "cloving/workflows/steps/wait-for-run";
import type { ReviewInput } from "./facts.ts";
import { proposalText, type Proposal } from "./report.ts";
import { labelIssue } from "./label.ts";

export async function handoffProposal(
  input: ReviewInput,
  proposal: Proposal,
): Promise<void> {
  const runId = await handoff({
    workflowId: "idea-to-issue",
    input: { idea: proposalText(proposal) },
  });
  const outcome = await waitForRun({ runId, maximumWaitSeconds: 86400 });
  const match =
    outcome.promotionId === null
      ? null
      : /^issue-([1-9]\d*)$/.exec(outcome.promotionId);
  const number = Number(match?.[1]);
  if (
    outcome.kind !== "handoff_requested" ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new Error("improvement-issue-missing");
  await labelIssue(input, { number, label: "cloving: improvement" });
}
