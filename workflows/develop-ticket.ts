import type { CycleOutcome } from "cloving/workflows";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { finishIssue, labelIssue } from "./issue-labels.ts";
import {
  fields,
  part,
  lastRound,
  review,
  prompt,
  turnPrompt,
  pullTitle,
  pullBody,
  type Ticket,
  type Round,
  type Pull,
  type Fix,
} from "./ticket-prompts.ts";

interface Decision {
  readonly gateId: string;
  readonly decision: string;
  readonly answer: string | null;
}

const lastFix = 3;

type Fields = Readonly<Record<string, unknown>>;

type Stepped =
  { readonly kind: "done"; readonly result: Fields } | CycleOutcome;

interface Call {
  readonly phase: string;
  readonly operation: string;
  readonly capability: string;
  readonly method: string;
  readonly round: number;
  readonly payload: string;
}

function blocked(
  cycleId: string,
  cause: { readonly reason: string; readonly evidenceId: string },
): CycleOutcome {
  return { kind: "blocked", cycleId, ...cause };
}

function decided(cycleId: string, decision: Decision): CycleOutcome | Round {
  const number = Number(decision.gateId.slice("review-".length));
  if (decision.decision === "approved")
    return {
      kind: "handoff_requested",
      cycleId,
      promotionId: `cloving-${cycleId}`,
    };
  if (decision.answer === null)
    return blocked(cycleId, {
      reason: "The operator denied the work.",
      evidenceId: decision.gateId,
    });
  if (number >= lastRound)
    return blocked(cycleId, {
      reason: `The operator denied the work of round ${String(number)}, and a run has at most ${String(lastRound)} rounds.`,
      evidenceId: decision.gateId,
    });
  return { number: number + 1, feedback: decision.answer };
}

async function stepped(input: Ticket, call: Call): Promise<Stepped> {
  const { phase, operation, round, capability, method, payload } = call;
  const done = await protectedEffect({
    scope: { phase, operation, round },
    capability,
    method,
    target: input.cycleId,
    payload,
    units: 1,
  });
  if (done.kind === "completed")
    return { kind: "done", result: fields(done.result) };
  const cause =
    "reason" in done && done.reason !== null ? ` (${done.reason})` : "";
  return blocked(input.cycleId, {
    reason: `The step ${operation} has the result ${done.kind}${cause}.`,
    evidenceId: operation,
  });
}

function github(
  input: Ticket,
  call: {
    readonly method: string;
    readonly round: number;
    readonly payload: unknown;
  },
): Promise<Stepped> {
  return stepped(input, {
    phase: "pull-request",
    operation: `github-${call.method}`,
    capability: "github",
    method: call.method,
    round: call.round,
    payload: JSON.stringify(call.payload),
  });
}

function pullOf(result: Fields): Pull {
  return {
    number: Number(result["number"]),
    url: part(result, "url"),
    commit: part(result, "commit"),
  };
}

async function merged(
  input: Ticket,
  done: {
    readonly round: number;
    readonly pull: Pull;
    readonly report: Fields;
  },
): Promise<CycleOutcome | Fix> {
  const { number, commit } = done.pull;
  const merge = await github(input, {
    method: "merge",
    round: done.round,
    payload: { number, commit },
  });
  if (merge.kind !== "done") return merge;
  if (typeof merge.result["reason"] !== "string")
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: `pull-request-${String(number)}`,
    };
  if (done.round > lastFix)
    return blocked(input.cycleId, {
      reason: `The merge has the result ${merge.result["reason"]} in round ${String(done.round)}, and a run has at most ${String(lastFix)} fix rounds. The pull request stays open: ${done.pull.url}`,
      evidenceId: "github-merge",
    });
  return {
    round: done.round + 1,
    pull: done.pull,
    review: merge.result,
    report: done.report,
  };
}

async function reviewedPull(
  input: Ticket,
  round: number,
): Promise<
  | CycleOutcome
  | { readonly kind: "reviewed"; readonly pull: Pull; readonly review: Fields }
> {
  const opened = await github(input, {
    method: "open-pr",
    round,
    payload: { title: pullTitle(input), body: pullBody(input) },
  });
  if (opened.kind !== "done") return opened;
  const pull = pullOf(opened.result);
  const reviewed = await github(input, {
    method: "wait-review",
    round,
    payload: { number: pull.number, commit: pull.commit },
  });
  return reviewed.kind === "done"
    ? { kind: "reviewed", pull, review: reviewed.result }
    : reviewed;
}

async function pullRequest(input: Ticket): Promise<CycleOutcome> {
  const prepared = await github(input, {
    method: "prepare",
    round: 1,
    payload: {},
  });
  if (prepared.kind !== "done") return prepared;
  await labelIssue(input, { key: "start", round: 1 });
  let fix: Fix | null = null;
  for (let round = 1; ; round += 1) {
    const turn = await stepped(input, {
      phase: "implement",
      operation: "claude-turn",
      capability: "claude",
      method: "run-turn",
      round,
      payload: turnPrompt(input, fix),
    });
    if (turn.kind !== "done")
      return finishIssue(input, { round, outcome: turn });
    const reviewed = await reviewedPull(input, round);
    if (reviewed.kind !== "reviewed")
      return finishIssue(input, { round, outcome: reviewed });
    const { pull } = reviewed;
    const score = reviewed.review["score"];
    if (score === 5) {
      const result = await merged(input, { round, pull, report: turn.result });
      if ("kind" in result)
        return finishIssue(input, {
          round,
          outcome: result,
          summary: part(turn.result, "summary"),
          status: turn.result["ticketStatus"],
        });
      fix = result;
      continue;
    }
    if (round > lastFix)
      return finishIssue(input, {
        round,
        outcome: blocked(input.cycleId, {
          reason: `Greptile gave the confidence score ${String(score)}/5 in round ${String(round)}, and a run has at most ${String(lastFix)} fix rounds. The pull request stays open: ${pull.url}`,
          evidenceId: "github-wait-review",
        }),
      });
    fix = {
      round: round + 1,
      pull,
      review: reviewed.review,
      report: turn.result,
    };
  }
}

export async function developTicket(
  input: Ticket,
  decision?: Decision,
): Promise<CycleOutcome> {
  "use workflow";
  if (input.delivery === "pull-request") return pullRequest(input);
  const { cycleId } = input;
  const round =
    decision === undefined
      ? { number: 1, feedback: null }
      : decided(cycleId, decision);
  if ("kind" in round) return round;
  const gateId = `review-${String(round.number)}`;
  const turn = await protectedEffect({
    scope: {
      phase: "implement",
      operation: "claude-turn",
      round: round.number,
    },
    capability: "claude",
    method: "run-turn",
    target: cycleId,
    payload: prompt(input, round),
    units: 1,
  });
  if (turn.kind !== "completed")
    return blocked(cycleId, {
      reason: `The Claude turn has the result ${turn.kind}.`,
      evidenceId: "claude-turn",
    });
  const gate = await decisionGate({
    gateId,
    kind: "approval",
    prompt: review(input, { round: round.number, result: turn.result }),
  });
  if (gate.kind !== "opened")
    return blocked(cycleId, {
      reason: `The review gate has the result ${gate.kind}.`,
      evidenceId: gateId,
    });
  return { kind: "waiting_for_decision", cycleId, decisionId: gate.decisionId };
}
