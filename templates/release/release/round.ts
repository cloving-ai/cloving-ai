import type { CycleOutcome, PullRequest } from "cloving/workflows";
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";
import { acceptWork } from "./accept.ts";
import type { ReleaseTask } from "./input.ts";
import { blocked } from "./outcome.ts";
import { openVersionPull } from "./pull.ts";
import { versionTurn, type ReleaseFeedback } from "./version.ts";

export type ReleaseStep =
  | { readonly step: "repair"; readonly feedback: ReleaseFeedback }
  | { readonly step: "merged"; readonly pull: PullRequest }
  | { readonly step: "stopped"; readonly outcome: CycleOutcome };

const waitReasons = [
  "ci-pending",
  "check-not-configured",
  "merge-queue-removed",
  "merge-queue-timeout",
];

export function repair(request: {
  readonly task: ReleaseTask;
  readonly result: { readonly reason: string | null; readonly output: string };
}): ReleaseStep {
  const reason = request.result.reason ?? "merge-failed";
  const { output } = request.result;
  if (waitReasons.includes(reason) || output.trim() === "")
    return {
      step: "stopped",
      outcome: blocked({
        cycleId: request.task.cycleId,
        reason,
        evidenceId: reason === "review-changes" ? "review" : "merge",
      }),
    };
  return { step: "repair", feedback: { reason, output } };
}

export async function versionRound(request: {
  readonly task: ReleaseTask;
  readonly base: string;
  readonly round: number;
  readonly feedback: ReleaseFeedback | null;
}): Promise<ReleaseStep> {
  const { task, round } = request;
  const notes = await versionTurn(request);
  const pull = await openVersionPull({ task, round, notes });
  const review = await acceptWork({
    target: pull.target,
    number: pull.number,
    commit: pull.commit,
  });
  if (!review.accepted)
    return repair({
      task,
      result: { reason: "review-changes", output: review.feedback },
    });
  const merge = await mergeWhenGreen({
    pull: pull,
    check: "beforeMerge",
    round: round,
  });
  if (!merge.merged) return repair({ task, result: merge });
  return { step: "merged", pull };
}

export async function nextRound(request: {
  readonly task: ReleaseTask;
  readonly base: string;
  readonly round: number;
  readonly last: ReleaseStep;
}): Promise<ReleaseStep> {
  const { task, base, round, last } = request;
  if (last.step !== "repair") return last;
  return await versionRound({ task, base, round, feedback: last.feedback });
}

export async function deliverVersion(request: {
  readonly task: ReleaseTask;
  readonly base: string;
}): Promise<ReleaseStep> {
  const { task, base } = request;
  let last = await versionRound({ task, base, round: 1, feedback: null });
  for (let round = 2; round <= 3; round += 1) {
    last = await nextRound({ task, base, round, last });
  }
  return last;
}

export function unmerged(request: {
  readonly task: ReleaseTask;
  readonly last: Exclude<ReleaseStep, { readonly step: "merged" }>;
}): CycleOutcome {
  const { task, last } = request;
  if (last.step === "stopped") return last.outcome;
  return blocked({
    cycleId: task.cycleId,
    reason: last.feedback.reason,
    evidenceId: "version",
  });
}
