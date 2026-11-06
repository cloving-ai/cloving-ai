import { handoff } from "cloving/workflows/steps/handoff";
import type { StuckPull } from "./status.ts";

function rescueInput(pull: StuckPull) {
  return Object.assign(
    { pullRequest: pull.number, reason: pull.reason },
    pull.issue === null ? {} : { issue: pull.issue },
    pull.ticketStatus === null ? {} : { ticketStatus: pull.ticketStatus },
  );
}

export async function rescuePull(request: {
  readonly pull: StuckPull;
}): Promise<string> {
  return await handoff({
    workflowId: "rescue-pr",
    input: rescueInput(request.pull),
  });
}

export async function rescuePulls(
  pulls: readonly StuckPull[],
): Promise<readonly StuckPull[]> {
  const rescued: StuckPull[] = [];
  for (let index = 0; index < 4; index += 1) {
    const pull = pulls.at(index);
    if (pull !== undefined) {
      await rescuePull({ pull: pull });
      rescued.push(pull);
    }
  }
  return rescued;
}
