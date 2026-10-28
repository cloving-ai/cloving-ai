import type { CycleOutcome } from "cloving/workflows";
import {
  ticketInput,
  type DevelopInput,
  type DevelopFeedback,
} from "./develop/report.ts";
import { preparePull, labelTicket } from "./develop/pull.ts";
import { developRound } from "./develop/round.ts";

export async function develop(request: DevelopInput): Promise<CycleOutcome> {
  "use workflow";
  const input = ticketInput(request);
  await preparePull(input.cycleId);
  await labelTicket(input, { key: "start", round: 1 });
  let endingRound = 1;
  let feedback: DevelopFeedback | null = null;
  let outcome: CycleOutcome | null = null;
  for (let round = 1; round <= 4; round += 1) {
    if (outcome === null) {
      endingRound = round;
      const next = await developRound({ input, round, feedback });
      if ("kind" in next) outcome = next;
      else feedback = next;
    }
  }
  if (outcome === null) throw new Error("development-round-limit");
  if (outcome.kind === "blocked")
    await labelTicket(input, { key: "blocked", round: endingRound });
  return outcome;
}
