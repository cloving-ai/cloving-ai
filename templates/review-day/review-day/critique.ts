import type { ReviewFacts } from "./facts.ts";
import type { Proposal, ReviewReport } from "./report.ts";

function removal(
  proposal: Proposal,
  context: {
    readonly draft: ReviewReport;
    readonly facts: ReviewFacts;
    readonly accepted: readonly Proposal[];
  },
): string | null {
  const original = context.draft.proposals.find(
    (item) => item.id === proposal.id,
  );
  if (JSON.stringify(original) !== JSON.stringify(proposal))
    return "not an unchanged analyzed proposal";
  if (
    proposal.evidence.length === 0 ||
    proposal.evidence.some((link) => !/^https?:\/\/\S+$/.test(link))
  )
    return "missing evidence";
  if (
    context.facts.improvements.some(
      (issue) =>
        typeof issue["loop"] !== "string" || issue["loop"] === proposal.loop,
    )
  )
    return "open improvement";
  if (context.accepted.some((item) => item.id === proposal.id))
    return "duplicate proposal";
  return context.accepted.length >= 3 ? "three proposal limit" : null;
}

export function enforceCritique(
  draft: ReviewReport,
  review: {
    readonly critique: ReviewReport;
    readonly facts: ReviewFacts;
  },
): ReviewReport {
  const proposals: Proposal[] = [];
  const removed = review.critique.removed.slice();
  for (const proposal of review.critique.proposals) {
    const reason = removal(proposal, {
      draft,
      facts: review.facts,
      accepted: proposals,
    });
    if (reason === null) proposals.push(proposal);
    else removed.push(`${proposal.id}: ${reason}`);
  }
  for (const proposal of draft.proposals)
    if (!review.critique.proposals.some((item) => item.id === proposal.id))
      removed.push(`${proposal.id}: removed by critique`);
  return Object.assign({}, review.critique, { proposals, removed });
}
