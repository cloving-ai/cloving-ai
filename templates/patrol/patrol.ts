import type { CycleOutcome } from "cloving/workflows";
import { patrolStatus, type PatrolInput } from "./patrol/status.ts";
import { askPerson as pickPulls } from "./patrol/pick.ts";
import { rescuePulls } from "./patrol/rescue.ts";
import { answerPulls } from "./patrol/answer.ts";

function numbers(pulls: readonly number[]): string {
  return pulls.map((pull) => `#${String(pull)}`).join(", ") || "none";
}

export async function patrol(input: PatrolInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    const status = await patrolStatus();
    const picked = await pickPulls({ input: input, pulls: status.stuck });
    const rescued = await rescuePulls(picked);
    const answered = await answerPulls({
      cycleId: input.cycleId,
      numbers: status.open,
    });
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "patrol",
      report: `Stuck pull requests: ${String(status.stuck.length)}. Rescues: ${numbers(rescued.map((pull) => pull.number))}. Review answers: ${numbers(answered)}.`,
    };
  } catch (error) {
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "patrol",
      reason:
        error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
          ? error.message
          : "patrol-failed",
    };
  }
}
