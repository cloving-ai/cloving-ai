import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { CycleOutcome } from "cloving/workflows";
import { effectResult, type IdeaInput } from "./idea-to-issue/effects.ts";
import { researchIdea } from "./idea-to-issue/turn.ts";
import { reviewByTurn as checkDraft } from "./idea-to-issue/turn.ts";
import { postAfterPrivacy as postDraft } from "./idea-to-issue/post.ts";
import { handoffIssue as nextIssue } from "./idea-to-issue/next.ts";

export async function ideaToIssue(input: IdeaInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    effectResult(
      await protectedEffect({
        capability: "github",
        method: "prepare",
        scope: { phase: "idea", operation: "prepare", round: 1 },
        target: input.cycleId,
        units: 1,
        payload: "{}",
      }),
    );
    await researchIdea(input);
    const digests = await checkDraft(input);
    const issue = await postDraft(input, digests);
    const outcome = await nextIssue(input, issue);
    effectResult(
      await protectedEffect({
        capability: "github",
        method: "discard",
        scope: { phase: "idea", operation: "discard", round: 1 },
        target: input.cycleId,
        units: 1,
        payload: "{}",
      }),
    );
    return outcome;
  } catch (error) {
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "idea-to-issue",
      reason: error instanceof Error ? error.message : "idea-to-issue-failed",
    };
  }
}
