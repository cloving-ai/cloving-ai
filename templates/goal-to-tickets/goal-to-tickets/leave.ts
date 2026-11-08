import type { CycleOutcome } from "cloving/workflows";
import { ticketsOutcome, type GoalInput, type Ticket } from "./effects.ts";

export async function leaveTickets(
  input: GoalInput,
  tickets: readonly Ticket[],
): Promise<CycleOutcome> {
  return Promise.resolve(
    ticketsOutcome(input, {
      tickets: tickets,
      next: "The tickets are left for a person.",
    }),
  );
}
