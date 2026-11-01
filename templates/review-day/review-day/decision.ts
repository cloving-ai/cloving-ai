import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import type { ReviewInput } from "./facts.ts";
import type { Proposal } from "./report.ts";

export async function chooseProposal(
  input: ReviewInput,
  proposals: readonly Proposal[],
): Promise<Proposal | null> {
  if (proposals.length === 0) return null;
  const result = await waitForDecision({
    gateId: `review-day:${input.cycleId}`,
    kind: "question",
    prompt: [
      "Approve at most one proposal: answer its number, or none. This authorizes only an idea-to-issue handoff, never a code or settings change.",
    ]
      .concat(
        proposals.map(
          (proposal, index) => `${String(index + 1)}. ${proposal.text}`,
        ),
      )
      .join("\n\n"),
  });
  if (!["approved", "answered"].includes(result.decision)) return null;
  const answer = result.answer?.trim() ?? "";
  return /^[1-3]$/.test(answer)
    ? (proposals.at(Number(answer) - 1) ?? null)
    : null;
}
