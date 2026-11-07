import type { CycleOutcome } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import {
  effectResult,
  ticketsOutcome,
  type GoalInput,
  type Ticket,
} from "./effects.ts";

export const readyLabel = "cloving: ready";

export function numbersText(tickets: readonly Ticket[]): string {
  if (tickets.length === 0) return "none";
  return tickets.map((ticket) => `#${String(ticket.number)}`).join(", ");
}

export async function labelReady(request: {
  readonly input: GoalInput;
  readonly ticket: Ticket;
}): Promise<void> {
  const { input, ticket } = request;
  effectResult(
    await protectedEffect({
      capability: "github",
      method: "label",
      scope: { phase: "goal", operation: "queue", round: ticket.draft },
      target: input.cycleId,
      units: 1,
      payload: JSON.stringify({
        number: ticket.number,
        add: [readyLabel],
        remove: [],
      }),
    }),
  );
}

export async function queueReady(
  input: GoalInput,
  tickets: readonly Ticket[],
): Promise<CycleOutcome> {
  for (let index = 0; index < 12; index += 1) {
    const ticket = tickets.at(index);
    if (ticket !== undefined)
      await labelReady({ input: input, ticket: ticket });
  }
  const waiting = tickets.filter((ticket) => !ticket.ready);
  return ticketsOutcome(input, {
    tickets: tickets,
    next: `Put in the queue: ${numbersText(tickets)}. Waiting for a blocker: ${numbersText(waiting)}.`,
  });
}
