import type { CycleOutcome } from "cloving/workflows";
import {
  waitForCommand,
  type CommandWaitOutcome,
} from "cloving/workflows/steps/wait-for-command";
import type { ReleaseTask } from "./input.ts";
import { blocked, fields } from "./outcome.ts";

const reason = "invalid-release-status";

function invalid(): never {
  throw new Error(reason);
}

function pullStates(value: unknown): ReadonlyMap<number, string> {
  const { pulls } = fields(value, reason);
  if (!Array.isArray(pulls)) invalid();
  return new Map(
    pulls.map((pull: unknown): [number, string] => {
      const { number, state } = fields(pull, reason);
      if (typeof number !== "number" || typeof state !== "string") invalid();
      return [number, state];
    }),
  );
}

export function pullsOutcome(
  task: ReleaseTask,
  outcome: CommandWaitOutcome,
): CycleOutcome | null {
  const { cycleId } = task;
  if (outcome.kind === "timed-out")
    return blocked({
      cycleId,
      reason: "pull-requests-not-merged",
      evidenceId: "pulls",
    });
  if (outcome.kind !== "ready")
    return blocked({ cycleId, reason: outcome.reason, evidenceId: "pulls" });
  const states = pullStates(outcome.value);
  const closed = task.pullRequests.filter(
    (number) => states.get(number) === "closed",
  );
  if (closed.length > 0)
    return blocked({
      cycleId,
      reason: `pull-request-closed: ${closed.map((number) => `#${String(number)}`).join(", ")}`,
      evidenceId: "pulls",
    });
  if (!task.pullRequests.every((number) => states.get(number) === "merged"))
    invalid();
  return null;
}

export async function waitForPulls(
  task: ReleaseTask,
): Promise<CycleOutcome | null> {
  if (task.pullRequests.length === 0) return null;
  const outcome = await waitForCommand({
    name: "release-pulls",
    input: { check: "pulls", pullRequests: task.pullRequests },
  });
  return pullsOutcome(task, outcome);
}
