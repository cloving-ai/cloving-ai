import type { CycleOutcome, PullRequest } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import type { DevelopFeedback } from "./report.ts";

export const lastRound = 6;

const choices = [
  { id: "more", label: "Two more rounds" },
  { id: "stop", label: "Stop and keep the pull request open" },
  { id: "close", label: "Close the pull request" },
];

export interface RecoveryRequest {
  readonly cycleId: string;
  readonly round: number;
  readonly pull: PullRequest;
  readonly feedback: DevelopFeedback;
}

export async function recoveryChoice(
  request: RecoveryRequest,
): Promise<string> {
  const { cycleId, round, pull, feedback } = request;
  const shown = choices.filter(
    (choice) => choice.id !== "more" || round < lastRound,
  );
  const decision = await waitForDecision({
    gateId: `recovery:${cycleId}:${String(round)}`,
    kind: "question",
    prompt: [
      `Pull request #${String(pull.number)} needs your decision: ${pull.url}`,
      `Round ${String(round)} ended with ${feedback.reason}. The run cannot continue without you.`,
      "",
      "Latest result:",
      feedback.output,
      "",
      "Answer with the number of one option:",
    ]
      .concat(
        shown.map(
          (choice) => `${String(choices.indexOf(choice) + 1)}. ${choice.label}`,
        ),
      )
      .join("\n"),
  });
  const answer = (decision.answer ?? "").trim().toLowerCase();
  const chosen = shown.find(
    (choice) =>
      answer === String(choices.indexOf(choice) + 1) ||
      answer === choice.label.toLowerCase(),
  );
  if (decision.decision !== "answered" || chosen === undefined) return "stop";
  return chosen.id;
}

function blockedAt(request: RecoveryRequest, reason: string): CycleOutcome {
  return {
    kind: "blocked",
    cycleId: request.cycleId,
    reason: `${reason}: ${request.pull.url}`,
    evidenceId:
      request.feedback.reason === "review-changes" ? "review" : "merge",
  };
}

export function stopped(request: RecoveryRequest): CycleOutcome {
  return blockedAt(request, request.feedback.reason);
}

export async function closed(request: RecoveryRequest): Promise<CycleOutcome> {
  const { cycleId, round, pull } = request;
  const result = await protectedEffect({
    scope: {
      phase: "pull-request",
      operation: "github-close-pr",
      round: round,
    },
    capability: "github",
    method: "close-pr",
    target: cycleId,
    payload: JSON.stringify({ number: pull.number }),
    units: 1,
  });
  if (result.kind === "completed")
    return blockedAt(request, "pull-request-closed");
  return blockedAt(request, result.reason ?? result.kind);
}
