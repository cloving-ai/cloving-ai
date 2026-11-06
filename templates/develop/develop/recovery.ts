import type {
  CycleOutcome,
  MergeResult,
  ProtectedResult,
  ProtectedScope,
  PullRequest,
} from "cloving/workflows";
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";
import { sleep } from "cloving/workflows/steps/sleep";
import {
  repair,
  waitReasons,
  type DevelopFeedback,
  type DevelopReport,
  type DevelopState,
  type RoundResult,
} from "./report.ts";
import { closed, lastRound, recoveryChoice, stopped } from "./decision.ts";
import { conflictText } from "./conflict.ts";

export const recovery = "person" as "person" | "stop";

const shortReasons = [
  "git-call-failed",
  "git-network-failed",
  "github-network-failed",
];

export function shortFailure(result: ProtectedResult): boolean {
  return (
    recovery === "person" &&
    result.kind === "failed" &&
    shortReasons.includes(result.reason ?? "")
  );
}

export async function retryPause(retry: number): Promise<void> {
  await sleep({ seconds: [60, 300, 900].at(retry - 1) ?? 900 });
}

export function retryScope(
  scope: {
    readonly phase: string;
    readonly operation: string;
    readonly round: number;
    readonly key?: string;
  },
  retry: number,
): ProtectedScope {
  if (retry === 0) return scope;
  return {
    phase: scope.phase,
    operation: scope.operation,
    round: scope.round,
    key:
      scope.key === undefined
        ? `retry-${String(retry)}`
        : `${scope.key}:retry-${String(retry)}`,
  };
}

export function stuck(state: {
  readonly cycleId: string;
  readonly result: ProtectedResult;
  readonly evidenceId: string;
}): CycleOutcome {
  return {
    kind: "blocked",
    cycleId: state.cycleId,
    reason: ("reason" in state.result ? state.result.reason : null) ?? "failed",
    evidenceId: state.evidenceId,
  };
}

function shortError(error: unknown): string | null {
  if (
    recovery === "stop" ||
    !(error instanceof Error) ||
    !shortReasons.includes(error.message)
  )
    return null;
  return error.message;
}

export async function retryMerge(request: {
  readonly pull: PullRequest;
  readonly round: number;
  readonly error: unknown;
}): Promise<MergeResult | CycleOutcome> {
  const { pull, round } = request;
  let failure = shortError(request.error);
  if (failure === null) throw request.error;
  let result: MergeResult | null = null;
  for (let retry = 1; retry <= 3; retry += 1)
    if (result === null) {
      await retryPause(retry);
      const next = await mergeAttempt({ pull, round, retry });
      if (typeof next === "string") failure = next;
      else result = next;
    }
  if (result !== null) return result;
  return {
    kind: "blocked",
    cycleId: pull.target,
    reason: `${failure}: ${pull.url}`,
    evidenceId: "merge",
  };
}

export async function mergeAttempt(request: {
  readonly pull: PullRequest;
  readonly round: number;
  readonly retry: number;
}): Promise<MergeResult | string> {
  try {
    return await mergeWhenGreen({
      pull: request.pull,
      check: "beforeMerge",
      round: request.round,
      retry: request.retry,
    });
  } catch (error) {
    const failure = shortError(error);
    if (failure === null) throw error;
    return failure;
  }
}

interface RecoveryInput {
  readonly state: DevelopState;
  readonly report: DevelopReport;
  readonly pull: PullRequest;
  readonly result: Omit<RoundResult, "merged">;
}

type RecoveryFeedback = DevelopFeedback & {
  readonly limit: number;
  readonly conflicts: number;
};

export async function recover(
  request: RecoveryInput,
): Promise<CycleOutcome | DevelopFeedback> {
  const { state, report, result } = request;
  const next = repair({
    cycleId: state.input.cycleId,
    round: state.round,
    report,
    result,
    limit: state.feedback?.limit ?? 4,
  });
  if (recovery === "stop") return next;
  const feedback = recoveryFeedback(request);
  return (
    recoveryStep({ next, feedback }) ?? (await askPerson(request, feedback))
  );
}

function recoveryStep(state: {
  readonly next: CycleOutcome | DevelopFeedback;
  readonly feedback: RecoveryFeedback;
}): CycleOutcome | DevelopFeedback | null {
  const { next, feedback } = state;
  const asked = feedback.conflicts >= 3 && feedback.reason === "merge-conflict";
  if (!asked && !("kind" in next)) return feedback;
  const kept = waitReasons.concat("not-approved").includes(feedback.reason);
  if ("kind" in next && kept) return next;
  return null;
}

async function askPerson(
  request: RecoveryInput,
  feedback: RecoveryFeedback,
): Promise<CycleOutcome | DevelopFeedback> {
  const { state, pull } = request;
  const { round } = state;
  const choice = { cycleId: state.input.cycleId, round, pull, feedback };
  const chosen = await recoveryChoice(choice);
  if (chosen === "close") return await closed(choice);
  if (chosen === "stop") return stopped(choice);
  return {
    reason: feedback.reason,
    output: feedback.output,
    remaining: feedback.remaining,
    limit: Math.max(feedback.limit, Math.min(round + 2, lastRound)),
    conflicts: feedback.conflicts,
  };
}

function recoveryFeedback(request: RecoveryInput): RecoveryFeedback {
  const { state, report, pull, result } = request;
  const conflicted = result.reason === "merge-conflict";
  const conflicts = (state.feedback?.conflicts ?? 0) + Number(conflicted);
  return {
    reason: result.reason ?? "merge-failed",
    output:
      conflicted && conflicts >= 2
        ? conflictText({ output: result.output, pull })
        : result.output,
    remaining: report.status.kind === "partial" ? report.status.remaining : [],
    limit: state.feedback?.limit ?? 4,
    conflicts,
  };
}
