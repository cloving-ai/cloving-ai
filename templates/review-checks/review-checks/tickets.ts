import { handoff } from "cloving/workflows/steps/handoff";
import { waitForRun } from "cloving/workflows/steps/wait-for-run";
import { kindText, scopeText, type Decided } from "./decision.ts";
import type { Suggestion } from "./suggestions.ts";

function coverage(suggestion: Suggestion): string {
  return suggestion.scope === "all"
    ? `The check covers all code. Fix or suppress each of the ${String(suggestion.hits)} hits on main in the same change.`
    : "The check covers only new and changed code. It does not report the hits on main that the change does not touch.";
}

export function ticketText(suggestion: Suggestion): string {
  const threads = suggestion.links.map((link) => `- ${link}`);
  return [
    `# Add the review check ${suggestion.name}`,
    "## Problem",
    `Reviews found this code shape in ${String(suggestion.links.length)} threads of the last week: ${suggestion.shape}`,
    threads.join("\n"),
    "## Desired outcome",
    `An automatic check finds the shape before the review: ${kindText(suggestion)}.`,
    `Check: ${suggestion.name}`,
    "## Concrete scenario",
    "A change brings back the shape of the first thread above. The developer gate reports it before the review.",
    "## Scope",
    [
      `1. ${kindText(suggestion)}.`,
      `2. ${coverage(suggestion)}`,
      `3. Main has ${String(suggestion.hits)} hits now. The command \`${suggestion.countCommand}\` counted them.`,
    ].join("\n"),
    "## Non-goals",
    "- No other rule or check.",
    "## Acceptance criteria",
    [
      "1. The check reports the shape of each thread in the problem.",
      `2. The check reports no hit in code outside its scope: ${scopeText(suggestion)}.`,
      "3. The developer gate passes.",
    ].join("\n"),
    "## First tests",
    "A fixture with the shape of the first thread fails the check. The same fixture with the fix passes.",
  ].join("\n\n");
}

export async function fileCheck(request: {
  readonly text: string;
}): Promise<string> {
  return await handoff({
    workflowId: "review-checks",
    input: { text: request.text },
  });
}

interface CheckRun {
  readonly name: string;
  readonly runId: string;
}

export async function handOffChecks(
  decided: readonly Decided[],
): Promise<readonly CheckRun[]> {
  const accepted = decided.filter((item) => item.decision === "accept");
  const runs: CheckRun[] = [];
  for (let index = 0; index < 5; index += 1) {
    const item = accepted.at(index);
    if (item !== undefined) {
      const runId = await fileCheck({ text: ticketText(item.suggestion) });
      runs.push({ name: item.suggestion.name, runId: runId });
    }
  }
  return runs;
}

async function filedIssue(run: CheckRun): Promise<boolean> {
  const outcome = await waitForRun({
    runId: run.runId,
    maximumWaitSeconds: 86400,
  });
  return outcome.kind === "handoff_requested";
}

export async function fileChecks(
  decided: readonly Decided[],
): Promise<readonly Decided[]> {
  const runs = await handOffChecks(decided);
  const missing = new Set<string>();
  for (const run of runs) if (!(await filedIssue(run))) missing.add(run.name);
  return decided.filter((item) => !missing.has(item.suggestion.name));
}
