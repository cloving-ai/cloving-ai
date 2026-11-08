import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { effectResult, type GoalInput } from "./effects.ts";

export async function prepareTree(input: GoalInput): Promise<void> {
  effectResult(
    await protectedEffect({
      capability: "github",
      method: "prepare",
      scope: { phase: "goal", operation: "prepare", round: 1 },
      target: input.cycleId,
      units: 1,
      payload: "{}",
    }),
  );
}

export async function discardTree(input: GoalInput): Promise<void> {
  effectResult(
    await protectedEffect({
      capability: "github",
      method: "discard",
      scope: { phase: "goal", operation: "discard", round: 1 },
      target: input.cycleId,
      units: 1,
      payload: "{}",
    }),
  );
}
