import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { CycleOutcome } from "cloving/workflows";
import { issueOutcome, effectResult, type IdeaInput } from "./effects.ts";
import type { PostedIssue } from "./post.ts";

export async function queueIssue(
  input: IdeaInput,
  issue: PostedIssue,
): Promise<CycleOutcome> {
  effectResult(
    await protectedEffect({
      capability: "github",
      method: "label",
      scope: { phase: "idea", operation: "queue", round: 1 },
      target: input.cycleId,
      units: 1,
      payload: JSON.stringify({
        owner: issue.owner,
        repository: issue.repository,
        number: issue.number,
        add: ["cloving: ready"],
        remove: [],
      }),
    }),
  );
  return issueOutcome(input, issue.number);
}
