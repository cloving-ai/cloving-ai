import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { reviewByPerson } from "cloving/workflows/steps/review-by-person";
import {
  draft,
  effectResult,
  resultFields,
  type IdeaInput,
} from "./effects.ts";

export async function captureDraft(input: IdeaInput, operation: string) {
  const result = resultFields(
    effectResult(
      await protectedEffect({
        capability: "github",
        method: "capture-draft",
        scope: { phase: "idea", operation, round: 1 },
        target: input.cycleId,
        units: 1,
        payload: JSON.stringify({ draft }),
      }),
    ),
  );
  const text = result["text"];
  const digest = result["digest"];
  if (
    typeof text !== "string" ||
    text.trim() === "" ||
    typeof digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(digest)
  )
    throw new Error("invalid-draft-capture");
  return { text, digest };
}

export async function reviewDraftByPerson(
  input: IdeaInput,
): Promise<readonly string[]> {
  const captured = await captureDraft(input, "capture-review");
  const result = await reviewByPerson({ subject: { draft: captured.text } });
  if (!result.accepted) throw new Error("draft-review-denied");
  return [captured.digest];
}
