import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import { captureDraft } from "./review.ts";
import { postAfterPrivacy, type PostedIssue } from "./post.ts";
import type { IdeaInput } from "./effects.ts";

export async function postByPerson(
  input: IdeaInput,
  digests: readonly string[],
): Promise<PostedIssue> {
  const captured = await captureDraft(input, "capture-post");
  const decision = await waitForDecision({
    gateId: `post:${input.cycleId}:${captured.digest}`,
    kind: "approval",
    prompt: `Approve posting this issue after the privacy check:\n${captured.text}`,
  });
  if (decision.decision !== "approved") throw new Error("post-not-approved");
  return postAfterPrivacy(input, digests.concat(captured.digest));
}
