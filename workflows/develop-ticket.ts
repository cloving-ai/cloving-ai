import type { CycleOutcome } from "cloving/workflows";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

interface Ticket {
  readonly cycleId: string;
  readonly ticket: string;
  readonly ticketId?: string;
  readonly repository: string;
  readonly delivery?: string;
}

interface Round {
  readonly number: number;
  readonly feedback: string | null;
}

interface Decision {
  readonly gateId: string;
  readonly decision: string;
  readonly answer: string | null;
}

const lastRound = 3;
const lastFix = 3;
const publicRule =
  "The branch becomes a public pull request. Do not write local file paths, such as the path of your home folder, in files or in commit messages.";

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

interface Pull {
  readonly number: number;
  readonly url: string;
  readonly commit: string;
}

interface Fix {
  readonly round: number;
  readonly pull: Pull;
  readonly review: Fields;
}

function instructions(repository: string): string {
  return [
    "You work on one ticket of this repository. Your current directory is a git work tree on its own branch.",
    `The main repository is at ${repository}. Do not change files there.`,
    `If this work tree has no node_modules folder and the main repository has one, make a copy-on-write clone: cp -c -R ${repository}/node_modules node_modules`,
    "Follow the instructions of the repository (AGENTS.md and CLAUDE.md).",
    "Use test-driven development: write a test that fails, see it fail, then write the code.",
    "Run the checks of the repository before you finish.",
    "Commit your work on the current branch. Do not push. Do not change a different branch.",
    "End with a short report: what you changed, the checks that you ran with their results, and what is not done.",
  ].join("\n");
}

function named(input: Ticket): string {
  return input.ticketId === undefined
    ? "this ticket"
    : `the ticket ${input.ticketId}`;
}

function fields(text: string | null): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text ?? "{}");
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function part(turn: Readonly<Record<string, unknown>>, name: string): string {
  const value = turn[name];
  if (Array.isArray(value)) return value.join("\n");
  if (typeof value === "number") return value.toFixed(2);
  return typeof value === "string" ? value : "";
}

function denial(round: number): string {
  return round < lastRound
    ? "Deny with a feedback text to send the work back to the worker for one more round. Deny with no text to reject the work."
    : "Deny to reject the work. This is the last round.";
}

function review(
  input: Ticket,
  turnResult: { readonly round: number; readonly result: string | null },
): string {
  const turn = fields(turnResult.result);
  return [
    `Review the work of the Claude worker for ${named(input)}.`,
    `Round: ${String(turnResult.round)} of ${String(lastRound)}`,
    `Branch: ${part(turn, "branch")}`,
    `Work tree: ${part(turn, "worktree")}`,
    `Cost (USD): ${part(turn, "costUsd")}`,
    "",
    "Commits:",
    part(turn, "commits"),
    "",
    "Changed files:",
    part(turn, "files"),
    "",
    "Not committed:",
    part(turn, "uncommitted"),
    "",
    "Report of the worker:",
    part(turn, "summary"),
    "",
    "Approve to accept the branch, then merge the branch yourself.",
    denial(turnResult.round),
  ].join("\n");
}

function blocked(
  cycleId: string,
  cause: { readonly reason: string; readonly evidenceId: string },
): CycleOutcome {
  return { kind: "blocked", cycleId, ...cause };
}

function prompt(input: Ticket, round: Round): string {
  const ticket = `${instructions(input.repository)}\n\nThe text of ${named(input)}:\n\n${input.ticket}`;
  if (round.feedback === null) return ticket;
  return `${ticket}\n\nThis is round ${String(round.number)}. The branch has the commits of the earlier rounds. The operator denied the work of round ${String(round.number - 1)} with this feedback:\n\n${round.feedback}`;
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

function pullPrompt(input: Ticket): string {
  return `${instructions(input.repository)}\n${publicRule}\n\nThe text of ${named(input)}:\n\n${input.ticket}`;
}

function findingLines(findings: unknown): string {
  if (!Array.isArray(findings)) return "";
  return findings
    .map((item: unknown) => {
      const finding = fields(JSON.stringify(item));
      const line = finding["line"];
      const place = typeof line === "number" ? `:${String(line)}` : "";
      return `- ${part(finding, "path")}${place}: ${part(finding, "body")}`;
    })
    .join("\n");
}

function turnPrompt(input: Ticket, fix: Fix | null): string {
  if (fix === null) return pullPrompt(input);
  const { round, pull, review } = fix;
  if (typeof review["reason"] === "string")
    return [
      pullPrompt(input),
      "",
      `This is round ${String(round)}. The merge of the pull request ${pull.url} needs a fix: ${review["reason"]}.`,
      review["reason"] === "merge-conflict"
        ? "Merge the default branch of origin into the branch, resolve each conflict, run the tests, and commit."
        : "The check failed on the tree of the merge of the branch with the newest commit of the default branch. Fix the cause and commit the fix.",
      "",
      part(review, "output"),
    ].join("\n");
  return [
    pullPrompt(input),
    "",
    `This is round ${String(round)}. The branch has the commits of the earlier rounds. Greptile reviewed the pull request ${pull.url} at the commit ${pull.commit.slice(0, 7)} and gave the confidence score ${String(review["score"])}/5. Fix each problem of the review, then commit the fixes. Cloving merges the pull request when the score is 5/5.`,
    "",
    "Summary of the review:",
    "",
    part(review, "summary"),
    "",
    "Findings on lines:",
    "",
    findingLines(review["findings"]),
  ].join("\n");
}

function pullTitle(input: Ticket): string {
  const [first = ""] = input.ticket.split("\n", 1);
  return first.startsWith("# ")
    ? first.slice(2).trim().slice(0, 200)
    : `Cloving task ${input.cycleId}`;
}

function pullBody(input: Ticket): string {
  const issue = /^GitHub issue: ([\w.-]+[/][\w.-]+#\d+)/m.exec(input.ticket);
  const about = `Cloving made this change for ${named(input)}. Greptile reviews the pull request, and Cloving merges it when the confidence score is 5/5.`;
  return issue === null ? about : `Closes ${String(issue[1])}\n\n${about}`;
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
  done: { readonly round: number; readonly pull: Pull },
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
  return { round: done.round + 1, pull: done.pull, review: merge.result };
}

async function pullRequest(input: Ticket): Promise<CycleOutcome> {
  const prepared = await github(input, {
    method: "prepare",
    round: 1,
    payload: {},
  });
  if (prepared.kind !== "done") return prepared;
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
    if (turn.kind !== "done") return turn;
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
    if (reviewed.kind !== "done") return reviewed;
    const score = reviewed.result["score"];
    if (score === 5) {
      const result = await merged(input, { round, pull });
      if ("kind" in result) return result;
      fix = result;
      continue;
    }
    if (round > lastFix)
      return blocked(input.cycleId, {
        reason: `Greptile gave the confidence score ${String(score)}/5 in round ${String(round)}, and a run has at most ${String(lastFix)} fix rounds. The pull request stays open: ${pull.url}`,
        evidenceId: "github-wait-review",
      });
    fix = { round: round + 1, pull, review: reviewed.result };
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
