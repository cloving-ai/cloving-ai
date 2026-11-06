import type { CycleOutcome, PullRequest } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { resultValue } from "./prepare.ts";
import type { RescueState } from "./turn.ts";
import type { RescueTask } from "./input.ts";

export async function pushPull(state: RescueState): Promise<PullRequest> {
  const number = String(state.task.pullRequest);
  const value = resultValue(
    await protectedEffect({
      scope: {
        phase: "rescue",
        operation: "github-open-pr",
        round: state.round,
      },
      capability: "github",
      method: "open-pr",
      target: state.tree.target,
      payload: JSON.stringify({
        title: `Rescue pull request #${number}`,
        body: `Cloving rescued pull request #${number}.`,
      }),
      units: 1,
    }),
  );
  const { url, commit } = value;
  if (value["number"] !== state.task.pullRequest)
    throw new Error("pull-request-changed");
  if (
    typeof url !== "string" ||
    typeof commit !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
  )
    throw new Error("invalid-rescue-result");
  return {
    number: state.task.pullRequest,
    url,
    commit,
    target: state.tree.target,
  };
}

export async function finishRescue(request: {
  readonly task: RescueTask;
  readonly round: number;
  readonly pull: PullRequest;
}): Promise<CycleOutcome> {
  const { task, round, pull } = request;
  const promotionId = `pull-request-${String(pull.number)}`;
  if (task.issue === null || !task.complete)
    return { kind: "handoff_requested", cycleId: task.cycleId, promotionId };
  const result = await protectedEffect({
    scope: { phase: "rescue", operation: "github-close-issue", round: round },
    capability: "github",
    method: "close-issue",
    target: pull.target,
    payload: JSON.stringify({
      owner: task.issue.owner,
      repository: task.issue.repository,
      number: task.issue.number,
      pullRequest: pull.number,
    }),
    units: 1,
  });
  if (result.kind === "completed")
    return { kind: "handoff_requested", cycleId: task.cycleId, promotionId };
  return {
    kind: "handoff_requested",
    cycleId: task.cycleId,
    promotionId,
    issueUpdate: "failed",
  };
}
