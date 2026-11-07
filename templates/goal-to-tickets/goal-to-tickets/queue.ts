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
  readonly ticket: Ticket | undefined;
}): Promise<readonly Ticket[]> {
  const { input, ticket } = request;
  if (ticket === undefined || !ticket.ready) return [];
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
  return [ticket];
}

export async function queueReady(
  input: GoalInput,
  tickets: readonly Ticket[],
): Promise<CycleOutcome> {
  let queued: readonly Ticket[] = [];
  for (let index = 0; index < 12; index += 1)
    queued = queued.concat(
      await labelReady({ input: input, ticket: tickets.at(index) }),
    );
  return ticketsOutcome(input, {
    tickets: tickets,
    next: `Put in the queue: ${numbersText(queued)}.`,
  });
}
