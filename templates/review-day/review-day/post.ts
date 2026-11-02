import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { effectText, fields, type ReviewInput } from "./facts.ts";
import { labelIssue } from "./label.ts";

export async function postAfterPrivacy(
  input: ReviewInput,
  report: string,
): Promise<void> {
  const result = fields(
    JSON.parse(
      effectText(
        await protectedEffect({
          capability: "github",
          method: "create-issue",
          target: input.cycleId,
          units: 1,
          scope: { phase: "review-day", operation: "post", round: 1 },
          payload: JSON.stringify({ text: report }),
        }),
      ),
    ),
  );
  const number = result["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("invalid-review-issue");
  await labelIssue(input, { number, label: "cloving: review" });
}
