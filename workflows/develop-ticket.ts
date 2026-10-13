import type { CycleOutcome } from "cloving/workflows";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

interface Ticket {
  readonly cycleId: string;
  readonly ticket: string;
  readonly ticketId?: string;
  readonly repository: string;
}

interface Decision {
  readonly gateId: string;
  readonly decision: string;
  readonly answer: string | null;
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
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function review(input: Ticket, result: string | null): string {
  const turn = fields(result);
  return [
    `Review the work of the Claude worker for ${named(input)}.`,
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
    "Approve to accept the branch, then merge the branch yourself. Deny to reject the work.",
  ].join("\n");
}

function blocked(
  cycleId: string,
  cause: { readonly reason: string; readonly evidenceId: string },
): CycleOutcome {
  return { kind: "blocked", cycleId, ...cause };
}

function decided(cycleId: string, decision: Decision): CycleOutcome {
  if (decision.decision !== "approved")
    return blocked(cycleId, {
      reason: "The operator denied the work.",
      evidenceId: decision.gateId,
    });
  return {
    kind: "handoff_requested",
    cycleId,
    promotionId: `cloving-${cycleId}`,
  };
}

export async function developTicket(
  input: Ticket,
  decision?: Decision,
): Promise<CycleOutcome> {
  "use workflow";
  const { cycleId } = input;
  if (decision !== undefined) return decided(cycleId, decision);
  const turn = await protectedEffect({
    scope: { phase: "implement", operation: "claude-turn", round: 1 },
    capability: "claude",
    method: "run-turn",
    target: cycleId,
    payload: `${instructions(input.repository)}\n\nThe text of ${named(input)}:\n\n${input.ticket}`,
    units: 1,
  });
  if (turn.kind !== "completed")
    return blocked(cycleId, {
      reason: `The Claude turn has the result ${turn.kind}.`,
      evidenceId: "claude-turn",
    });
  const gate = await decisionGate({
    gateId: "review-1",
    kind: "approval",
    prompt: review(input, turn.result),
  });
  if (gate.kind !== "opened")
    return blocked(cycleId, {
      reason: `The review gate has the result ${gate.kind}.`,
      evidenceId: "review-1",
    });
  return { kind: "waiting_for_decision", cycleId, decisionId: gate.decisionId };
}
