import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import {
  draft,
  effectResult,
  resultFields,
  type IdeaInput,
} from "./effects.ts";

export interface PostedIssue {
  readonly number: number;
  readonly owner: string;
  readonly repository: string;
}

export async function postAfterPrivacy(
  input: IdeaInput,
  expectedDigests: readonly string[],
): Promise<PostedIssue> {
  const result = resultFields(
    effectResult(
      await protectedEffect({
        capability: "github",
        method: "create-issue",
        scope: { phase: "idea", operation: "post", round: 1 },
        target: input.cycleId,
        units: 1,
        payload: JSON.stringify(
          expectedDigests.length === 0 ? { draft } : { draft, expectedDigests },
        ),
      }),
    ),
  );
  const number = result["number"];
  const url = result["url"];
  const match =
    typeof url === "string"
      ? /^https?:\/\/[^/\s]+\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)$/.exec(
          url,
        )
      : null;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    match === null ||
    Number(match[3]) !== number
  )
    throw new Error("invalid-issue-result");
  return { number, owner: String(match[1]), repository: String(match[2]) };
}
