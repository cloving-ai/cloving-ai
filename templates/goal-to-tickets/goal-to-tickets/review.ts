import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { effectResult, planFile, type GoalInput } from "./effects.ts";
import { boundary, capturePlan, plannedOf, type PlannedGoal } from "./turn.ts";

export function reviewPrompt(plan: PlannedGoal): string {
  return [
    `Check each of the ${String(plan.order.length)} drafts in ${planFile} against the code and the tests of this repository. Correct the file in place.`,
    'Keep the line "# Draft N: <title>" at the start of each draft, the numbers of the drafts, the ticket sections and the "Needs draft N" lines. The dependencies must not make a cycle. Keep 1 to 12 drafts.',
    "Remove secrets, private names, local file paths, mentions of persons with @ and links to issues or pull requests of other repositories.",
    boundary,
  ].join("\n\n");
}

export async function reviewByTurn(
  input: GoalInput,
  plan: PlannedGoal,
): Promise<PlannedGoal> {
  effectResult(
    await protectedEffect({
      capability: "claude",
      method: "run-turn",
      scope: { phase: "goal", operation: "review", round: 1 },
      target: input.cycleId,
      units: 1,
      payload: reviewPrompt(plan),
    }),
  );
  return plannedOf(
    await capturePlan(input, { operation: "capture-review", round: 1 }),
  );
}
