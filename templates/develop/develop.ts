import type { CycleOutcome } from "cloving/workflows";
import {
  ticketInput,
  endOf,
  type DevelopInput,
  type DevelopFeedback,
  type DevelopFailure,
} from "./develop/report.ts";
import { preparePull, labelTicket, blockTicket } from "./develop/pull.ts";
import { developRound } from "./develop/round.ts";

export async function develop(request: DevelopInput): Promise<CycleOutcome> {
  "use workflow";
  const input = ticketInput(request);
  await preparePull(input.cycleId);
  const started = await labelTicket(input, { key: "start", round: 1 });
  if (started !== null) return started;
  let endingRound = 1;
  let feedback: DevelopFeedback | null = null;
  let outcome: CycleOutcome | null = null;
  let failure: DevelopFailure | null = null;
  try {
    for (let round = 1; round <= 6; round += 1) {
      if (outcome === null) {
        endingRound = round;
        const next = await developRound({ input, round, feedback });
        outcome = "kind" in next ? next : null;
        feedback = "kind" in next ? feedback : next;
      }
    }
  } catch (error) {
    failure = { error };
  }
  if (failure !== null || outcome?.kind === "blocked")
    failure = await blockTicket(input, { round: endingRound, failure });
  return endOf({ outcome, failure });
}
