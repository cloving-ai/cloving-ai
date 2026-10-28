import type { ProtectedResult } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export interface QueuePartialInput {
  readonly cycleId: string;
  readonly round: number;
  readonly remaining: readonly string[];
  readonly issue: {
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
  };
  readonly pullRequest: number;
}

export async function queuePartial(
  input: QueuePartialInput,
): Promise<ProtectedResult> {
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > 4)
    throw new Error("invalid-development-round");
  return await protectedEffect({
    scope: {
      phase: "pull-request",
      operation: "github-partial-issue",
      round: input.round,
    },
    capability: "github",
    method: "partial-issue",
    target: input.cycleId,
    units: 1,
    payload: JSON.stringify({
      owner: input.issue.owner,
      repository: input.issue.repository,
      number: input.issue.number,
      pullRequest: input.pullRequest,
      remaining: input.remaining,
    }),
  });
}
