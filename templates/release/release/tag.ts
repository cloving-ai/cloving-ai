import type { CycleOutcome } from "cloving/workflows";
import { runCommand } from "cloving/workflows/steps/run-command";
import {
  waitForCommand,
  type CommandWaitOutcome,
} from "cloving/workflows/steps/wait-for-command";
import { blocked, fields, resultValue } from "./outcome.ts";
import type { PublishRequest } from "./publish.ts";

export interface TaggedRelease extends PublishRequest {
  readonly commit: string;
}

export async function pushTag(request: PublishRequest): Promise<TaggedRelease> {
  const { task, pull } = request;
  const { tag, commit } = resultValue(
    await runCommand({
      scope: { phase: "publish", operation: "push-tag", round: 1 },
      name: "push-tag",
      input: {
        version: task.version,
        tag: task.tag,
        pullRequest: pull.number,
      },
    }),
    "invalid-push-tag-result",
  );
  if (
    tag !== task.tag ||
    typeof commit !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
  )
    throw new Error("invalid-push-tag-result");
  return { task, pull, commit };
}

function failedReason(output: string): string {
  const text = output.trim();
  return text === "" ? "tag-ci-failed" : `tag-ci-failed: ${text.slice(-240)}`;
}

export function statusOutcome(
  release: TaggedRelease,
  outcome: CommandWaitOutcome,
): CycleOutcome {
  const { task, pull } = release;
  const { cycleId } = task;
  if (outcome.kind === "timed-out")
    return blocked({
      cycleId,
      reason: "release-not-published",
      evidenceId: "tag",
    });
  if (outcome.kind !== "ready")
    return blocked({ cycleId, reason: outcome.reason, evidenceId: "tag" });
  const { state, output } = fields(outcome.value, "invalid-release-status");
  if (state === "published")
    return {
      kind: "handoff_requested",
      cycleId,
      promotionId: task.tag,
      report: `Published ${task.tag} from pull request #${String(pull.number)}.`,
    };
  if (state !== "failed" || typeof output !== "string")
    throw new Error("invalid-release-status");
  return blocked({ cycleId, reason: failedReason(output), evidenceId: "tag" });
}

export async function releaseStatus(
  release: TaggedRelease,
): Promise<CycleOutcome> {
  const { task, commit } = release;
  const outcome = await waitForCommand({
    name: "release-status",
    input: {
      check: "release",
      version: task.version,
      tag: task.tag,
      commit: commit,
    },
  });
  return statusOutcome(release, outcome);
}
