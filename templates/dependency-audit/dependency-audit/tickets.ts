import { handoff } from "cloving/workflows/steps/handoff";
import type { TicketPlan } from "./plan.ts";
import { ticketText } from "./ticket.ts";

export function ordered(plans: readonly TicketPlan[]): readonly TicketPlan[] {
  return plans
    .filter((plan) => plan.severity === "critical")
    .concat(plans.filter((plan) => plan.severity !== "critical"))
    .slice(0, 5);
}

export async function fileTicket(request: {
  readonly text: string;
}): Promise<string> {
  return await handoff({
    workflowId: "dependency-ticket",
    input: { text: request.text },
  });
}

export async function fileTickets(
  plans: readonly TicketPlan[],
): Promise<readonly TicketPlan[]> {
  const chosen = ordered(plans);
  const texts = chosen.map((plan) => ticketText(plan));
  for (let index = 0; index < 5; index += 1) {
    const text = texts.at(index);
    if (text !== undefined) await fileTicket({ text: text });
  }
  return chosen;
}
