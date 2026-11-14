import { readyIssuesOf, blockerStatesOf } from "./develop/feed-results.ts";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import {
  blockersOf,
  selected,
  type BlockerState,
} from "./develop/feed-selection.ts";
import type { CycleOutcome } from "cloving/workflows";
import {
  ticketInput,
  endOf,
  type DevelopInput,
  type DevelopFeedback,
  type DevelopFailure,
} from "./develop/report.ts";
import { preparePull, labelTicket, blockTicket } from "./develop/pull.ts";
import { developRound } from "./develop/round.ts";

export async function develop(request: DevelopInput): Promise<CycleOutcome> {
  "use workflow";
  const input = await preparePull(ticketInput(request));
  const started = await labelTicket(input, { key: "start", round: 1 });
  if (started !== null) return started;
  let endingRound = 1;
  let feedback: DevelopFeedback | null = null;
  let outcome: CycleOutcome | null = null;
  let failure: DevelopFailure | null = null;
  try {
    for (let round = 1; round <= 6; round += 1) {
      if (outcome === null) {
        endingRound = round;
        const next = await developRound({ input, round, feedback });
        outcome = "kind" in next ? next : null;
        feedback = "kind" in next ? feedback : next;
      }
    }
  } catch (error) {
    failure = { error };
  }
  if (failure !== null || outcome?.kind === "blocked")
    failure = await blockTicket(input, { round: endingRound, failure });
  return endOf({ outcome, failure });
}

export async function developFeed() {
  "use workflow";
  const issues = await protectedEffect({
    scope: { phase: "feed", operation: "ready-issues", round: 1 },
    capability: "github",
    method: "issues",
    target: "issues",
    units: 1,
    payload: JSON.stringify({
      labels: ["cloving: ready"],
      state: "open",
      limit: 100,
    }),
  });
  if (issues.kind !== "completed")
    throw new Error(issues.reason ?? "github-call-failed");
  if (issues.result === null) throw new Error("github-call-failed");
  const ready = readyIssuesOf(issues.result);
  const numbers = Array.from(
    new Set(ready.flatMap((issue) => blockersOf(issue.body))),
  );
  let states: readonly BlockerState[] = [];
  for (let offset = 0; offset < numbers.length; offset += 50) {
    const result = await protectedEffect({
      scope: { phase: "feed", operation: "blocker-states", round: offset + 1 },
      capability: "github",
      method: "issue-states",
      target: "issues",
      units: 1,
      payload: JSON.stringify({ numbers: numbers.slice(offset, offset + 50) }),
    });
    if (result.kind !== "completed")
      throw new Error(result.reason ?? "github-call-failed");
    if (result.result === null) throw new Error("github-call-failed");
    states = states.concat(blockerStatesOf(result.result));
  }
  return selected(ready, { states, active: [] });
}
