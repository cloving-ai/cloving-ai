import { runCommand } from "cloving/workflows/steps/run-command";
import type { CycleOutcome } from "cloving/workflows";

type VerificationFeedback = {
  readonly reason: string;
  readonly output: string;
};

export async function verifyRedGreen(input: {
  readonly cycleId: string;
  readonly head: string;
  readonly round: number;
}): Promise<CycleOutcome | VerificationFeedback | null> {
  const unavailable: CycleOutcome = {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "red-green-unavailable",
    evidenceId: "red-green",
  };
  try {
    const result = await runCommand({
      name: "red-green",
      scope: { phase: "verify", operation: "red-green", round: input.round },
      input: { head: input.head },
    });
    if (result.kind !== "completed") return unavailable;
    const feedback = verdictFeedback(result.result);
    return feedback === undefined ? unavailable : feedback;
  } catch {
    return unavailable;
  }
}

function verdictFeedback(
  text: string | null,
): VerificationFeedback | null | undefined {
  const value: unknown = JSON.parse(text ?? "null");
  if (
    typeof value !== "object" ||
    value === null ||
    !("verdict" in value) ||
    typeof value.verdict !== "string" ||
    !("output" in value) ||
    typeof value.output !== "string"
  )
    return undefined;
  if (["accepted", "no-test-change"].includes(value.verdict)) return null;
  if (
    ["false-red", "red-not-assertion", "skipped-test", "green-failed"].includes(
      value.verdict,
    )
  )
    return { reason: value.verdict, output: value.output };
  return undefined;
}
