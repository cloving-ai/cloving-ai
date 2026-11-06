import type { CycleOutcome } from "cloving/workflows";
import { stuckPulls, type PatrolInput } from "./patrol/status.ts";
import { askPerson as pickPulls } from "./patrol/pick.ts";
import { rescuePulls } from "./patrol/rescue.ts";

export async function patrol(input: PatrolInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    const pulls = await stuckPulls();
    const picked = await pickPulls({ input: input, pulls: pulls });
    const rescued = await rescuePulls(picked);
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "patrol",
      report: `Stuck pull requests: ${String(pulls.length)}. Rescues: ${rescued.map((pull) => `#${String(pull.number)}`).join(", ") || "none"}.`,
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
