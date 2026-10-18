import { ticketStatus, type CycleOutcome } from "cloving/workflows";
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
  ending: {
    readonly round: number;
    readonly outcome: CycleOutcome;
    readonly summary?: string;
    readonly status?: unknown;
  },
): Promise<CycleOutcome> {
  if (ending.outcome.kind === "handoff_requested")
    return finishMergedIssue(input, ending);
  await labelIssue(input, {
    round: ending.round,
    key: ending.outcome.kind === "blocked" ? "blocked" : "done",
  });
  return ending.outcome;
}

async function finishMergedIssue(
  input: IssueTicket,
  ending: {
    readonly round: number;
    readonly outcome: CycleOutcome;
    readonly summary?: string;
    readonly status?: unknown;
  },
): Promise<CycleOutcome> {
  if (ending.outcome.kind !== "handoff_requested") return ending.outcome;
  const status = ticketStatus(ending.summary ?? "", ending.status);
  const method = status.kind === "complete" ? "close-issue" : "partial-issue";
  const issue = /^GitHub issue: ([\w.-]+)\/([\w.-]+)#(\d+)/m.exec(input.ticket);
  const outcome = { ...ending.outcome, ticketStatus: status.kind };
  if (issue === null) return outcome;
  const update = await protectedEffect({
    scope: {
      phase: "pull-request",
      operation: `github-${method}`,
      round: ending.round,
    },
    capability: "github",
    method,
    target: input.cycleId,
    units: 1,
    payload: JSON.stringify({
      owner: issue[1],
      repository: issue[2],
      number: Number(issue[3]),
      pullRequest: Number(
        ending.outcome.promotionId.slice("pull-request-".length),
      ),
      ...(status.kind === "partial" ? { remaining: status.remaining } : {}),
    }),
  });
  if (update.kind === "completed") return outcome;
  return { ...outcome, issueUpdate: "failed" };
}
