import type { CycleOutcome, PullRequest } from "cloving/workflows";
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import type { ReleaseTask } from "./input.ts";
import { blocked } from "./outcome.ts";

export interface PublishRequest {
  readonly task: ReleaseTask;
  readonly pull: PullRequest;
}

export function publishPrompt(request: PublishRequest): string {
  const { task, pull } = request;
  return [
    `Publish ${task.tag}?`,
    `The version pull request #${String(pull.number)} (${pull.url}) is merged. Approve to push the tag ${task.tag} on its merge commit. The tag CI then publishes the package and creates the release. Deny to stop the release with no tag.`,
  ].join("\n\n");
}

export async function askPerson(
  request: PublishRequest,
): Promise<PublishRequest | CycleOutcome> {
  const result = await waitForDecision({
    gateId: `publish:${request.task.tag}`,
    kind: "approval",
    prompt: publishPrompt(request),
  });
  if (result.decision === "approved") return request;
  return blocked({
    cycleId: request.task.cycleId,
    reason:
      result.decision === "expired" ? "publish-expired" : "publish-denied",
    evidenceId: "publish",
  });
}

export async function afterMerge(
  request: PublishRequest,
): Promise<PublishRequest | CycleOutcome> {
  return await Promise.resolve(request);
}
