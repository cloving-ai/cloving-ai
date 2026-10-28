import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";

export interface PartialWorkInput {
  readonly cycleId: string;
  readonly round: number;
  readonly remaining: readonly string[];
}

export async function reviewPartial(
  input: PartialWorkInput,
): Promise<string | null> {
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > 4)
    throw new Error("invalid-development-round");
  if (input.round === 4) return null;
  const decision = await waitForDecision({
    gateId: `partial:${input.cycleId}:${String(input.round)}`,
    kind: "question",
    prompt: [
      "Some work remains:",
      input.remaining.map((item) => `- ${item}`).join("\n"),
      "",
      "Describe the next fix to continue, or submit an empty answer to stop.",
    ].join("\n"),
  });
  if (decision.decision !== "answered" || decision.answer?.trim() === "")
    return null;
  return decision.answer;
}
