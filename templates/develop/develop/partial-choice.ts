import type { CycleOutcome } from "cloving/workflows";
import type { DevelopTask, DevelopReport, DevelopFeedback } from "./report.ts";
import { reviewPartial } from "./partial.ts";

export async function partialChoice(request: {
  readonly input: DevelopTask;
  readonly round: number;
  readonly report: DevelopReport;
}): Promise<CycleOutcome | DevelopFeedback | null> {
  const { input, round, report } = request;
  if (report.status.kind !== "partial") return null;
  const answer = await reviewPartial({
    cycleId: input.cycleId,
    round,
    remaining: report.status.remaining,
  });
  if (answer === null)
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "partial-work",
      evidenceId: `partial:${input.cycleId}:${String(round)}`,
    };
  return {
    reason: "partial-work",
    output: answer,
    remaining: report.status.remaining,
  };
}
