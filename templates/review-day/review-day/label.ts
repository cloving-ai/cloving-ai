import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { effectText, type ReviewInput } from "./facts.ts";

export async function labelIssue(
  input: ReviewInput,
  issue: { readonly number: number; readonly label: string },
) {
  effectText(
    await protectedEffect({
      capability: "github",
      method: "label",
      target: input.cycleId,
      units: 1,
      scope: {
        phase: "review-day",
        operation:
          issue.label === "cloving: review"
            ? "label-review"
            : "label-improvement",
        round: 1,
      },
      payload: JSON.stringify({
        number: issue.number,
        add: [issue.label],
        remove: [],
      }),
    }),
  );
}
