import type { DecisionResult } from "cloving/workflows";
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import type { Answer } from "./facts.ts";
import type { ChecksInput } from "./input.ts";
import type { Suggestion } from "./suggestions.ts";

export interface Decided {
  readonly suggestion: Suggestion;
  readonly decision: Answer;
}

export function kindText(suggestion: Suggestion): string {
  if (suggestion.kind === "enable-rule")
    return `turn on the ESLint rule \`${suggestion.rule}\``;
  if (suggestion.kind === "new-rule")
    return `add the new ESLint rule \`${suggestion.rule}\``;
  return `add the new quality check \`${suggestion.rule}\``;
}

export function scopeText(suggestion: Suggestion): string {
  return suggestion.scope === "all" ? "all code" : "only new and changed code";
}

export function decisionPrompt(suggestions: readonly Suggestion[]): string {
  return [
    'Answer accept, reject or defer for each suggested check, in this order, separated by spaces, for example "accept reject defer". Each accepted check becomes one issue with the label cloving: check. A rejected check never comes back. A deferred check comes back when new review threads give more evidence.',
  ]
    .concat(
      suggestions.map(
        (suggestion, index) =>
          `${String(index + 1)}. ${suggestion.name}: ${kindText(suggestion)} for ${scopeText(suggestion)}. Shape: ${suggestion.shape} Hits on main: ${String(suggestion.hits)} (\`${suggestion.countCommand}\`). Threads: ${suggestion.links.join(" ")}`,
      ),
    )
    .join("\n\n");
}

function answerOf(word: string): Answer {
  if (word === "accept" || word === "reject" || word === "defer") return word;
  throw new Error("invalid-check-answer");
}

export function answersOf(
  result: DecisionResult,
  suggestions: readonly Suggestion[],
): readonly Decided[] {
  if (result.decision !== "answered" && result.decision !== "approved")
    throw new Error("check-question-not-answered");
  const words = (result.answer ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((word) => word !== "")
    .map((word) => answerOf(word));
  if (words.length !== suggestions.length)
    throw new Error("invalid-check-answer");
  return suggestions.map((suggestion, index) => ({
    suggestion: suggestion,
    decision: words.at(index) ?? "defer",
  }));
}

export async function askPerson(
  input: ChecksInput,
  suggestions: readonly Suggestion[],
): Promise<readonly Decided[]> {
  return answersOf(
    await waitForDecision({
      gateId: `review-checks:${input.cycleId}`,
      kind: "question",
      prompt: decisionPrompt(suggestions),
    }),
    suggestions,
  );
}
