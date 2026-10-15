import type { CycleOutcome } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

interface IssueTicket {
  readonly cycleId: string;
  readonly ticket: string;
}

export async function labelIssue(
  input: IssueTicket,
  state: { readonly key: "start" | "blocked" | "done"; readonly round: number },
): Promise<void> {
  const issue = /^GitHub issue: ([\w.-]+)\/([\w.-]+)#(\d+)/m.exec(input.ticket);
  if (issue === null) return;
  const additions = {
    start: ["cloving: in progress"],
    blocked: ["cloving: blocked"],
    done: [],
  };
  const add = additions[state.key];
  const remove =
    state.key === "start"
      ? ["cloving: ready", "cloving: blocked"]
      : ["cloving: in progress"];
  await protectedEffect({
    scope: { phase: "pull-request", operation: "github-label", ...state },
    capability: "github",
    method: "label",
    target: input.cycleId,
    units: 1,
    payload: JSON.stringify({
      owner: issue[1],
      repository: issue[2],
      number: Number(issue[3]),
      add,
      remove,
    }),
  });
}

export async function finishIssue(
  input: IssueTicket,
  ending: { readonly round: number; readonly outcome: CycleOutcome },
): Promise<CycleOutcome> {
  await labelIssue(input, {
    round: ending.round,
    key: ending.outcome.kind === "blocked" ? "blocked" : "done",
  });
  return ending.outcome;
}
