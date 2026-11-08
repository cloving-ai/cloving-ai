import type { CycleOutcome } from "cloving/workflows";
import { handoff } from "cloving/workflows/steps/handoff";
import {
  failureReason,
  ticketsOutcome,
  type GoalInput,
  type Ticket,
} from "./effects.ts";
import { labelReady } from "./queue.ts";

export const targetWorkflow = "develop";

export async function queueAfterFailure(request: {
  readonly input: GoalInput;
  readonly tickets: readonly Ticket[];
  readonly first: Ticket;
  readonly reason: string;
}): Promise<CycleOutcome> {
  const { input, tickets, first, reason } = request;
  const number = `#${String(first.number)}`;
  try {
    await labelReady({ input: input, ticket: first });
    return Object.assign(
      ticketsOutcome(input, {
        tickets: tickets,
        next: `The handoff of ${number} failed, so ${number} is in the queue.`,
      }),
      { reason: reason },
    );
  } catch {
    return Object.assign(
      ticketsOutcome(input, {
        tickets: tickets,
        next: `The handoff of ${number} failed, and the ready label is not added.`,
      }),
      { reason: reason, issueUpdate: "failed" as const },
    );
  }
}

export async function handoffFirst(
  input: GoalInput,
  tickets: readonly Ticket[],
): Promise<CycleOutcome> {
  const first = tickets.find((ticket) => ticket.ready);
  if (first === undefined)
    return ticketsOutcome(input, {
      tickets: tickets,
      next: "No ticket is ready.",
    });
  try {
    await handoff({
      workflowId: targetWorkflow,
      input: { ticket: String(first.number) },
    });
    return ticketsOutcome(input, {
      tickets: tickets,
      next: `Handed #${String(first.number)} to ${targetWorkflow}.`,
    });
  } catch (error) {
    return await queueAfterFailure({
      input: input,
      tickets: tickets,
      first: first,
      reason: failureReason(error),
    });
  }
}
