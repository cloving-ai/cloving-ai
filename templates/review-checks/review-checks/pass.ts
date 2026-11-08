import type { CycleOutcome } from "cloving/workflows";
import { askPerson, type Decided } from "./decision.ts";
import { reviewFacts, type Answer, type ReviewFacts } from "./facts.ts";
import type { ChecksInput } from "./input.ts";
import { recordDecisions } from "./record.ts";
import { keptSuggestions } from "./suggestions.ts";
import { fileChecks } from "./tickets.ts";
import { suggestChecks } from "./turn.ts";

function completed(request: ChecksInput, report: string): CycleOutcome {
  return {
    kind: "handoff_requested",
    cycleId: request.cycleId,
    promotionId: "review-checks",
    report: report,
  };
}

function possibleGroup(facts: ReviewFacts): boolean {
  return (
    facts.comments.length >= 3 &&
    new Set(facts.comments.map((comment) => comment.pullRequest)).size >= 2
  );
}

function tally(decided: readonly Decided[], answer: Answer): string {
  const names = decided
    .filter((item) => item.decision === answer)
    .map((item) => item.suggestion.name);
  return names.length === 0
    ? "0"
    : `${String(names.length)} (${names.join(", ")})`;
}

export async function checksPass(request: ChecksInput): Promise<CycleOutcome> {
  const facts = await reviewFacts();
  if (!possibleGroup(facts))
    return completed(request, "No group of review threads this week.");
  const suggestions = keptSuggestions(
    await suggestChecks({ input: request, facts: facts }),
    facts,
  );
  if (suggestions.length === 0)
    return completed(request, "No group of review threads this week.");
  const decided = await askPerson(request, suggestions);
  const filed = await fileChecks(decided);
  await recordDecisions(filed);
  if (filed.length !== decided.length) throw new Error("check-issue-missing");
  return completed(
    request,
    `Suggestions: ${String(decided.length)}. Accepted: ${tally(decided, "accept")}. Rejected: ${tally(decided, "reject")}. Deferred: ${tally(decided, "defer")}.`,
  );
}
