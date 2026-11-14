import {
  issuePayload,
  mergedReady,
  continuedCursor,
  completedFeedText,
} from "./develop/feed-read.ts";
import { readyIssuePageOf, blockerStatesOf } from "./develop/feed-results.ts";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import {
  blockerNumbersOf,
  selected,
  type BlockerState,
  type ReadyIssue,
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
  let ready: readonly ReadyIssue[] = [];
  let cursor: number | null = 0;
  let remainingReads = 87;
  for (let round = 1; cursor !== null; round++) {
    const result = await protectedEffect({
      scope: { phase: "feed", operation: "ready-issues", round },
      capability: "github",
      method: "issues",
      target: "issues",
      units: 1,
      payload: issuePayload(cursor),
    });
    remainingReads -= 1;
    const page = readyIssuePageOf(completedFeedText(result));
    ready = mergedReady(ready, page.issues);
    cursor = continuedCursor(cursor, {
      next: page.cursor,
      count: ready.length,
    });
  }
  const numbers = blockerNumbersOf(ready, Math.max(0, remainingReads) * 50);
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
    states = states.concat(blockerStatesOf(completedFeedText(result)));
  }
  return selected(ready, { states, active: [] });
}
