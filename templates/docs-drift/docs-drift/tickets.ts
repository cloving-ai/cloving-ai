import { handoff } from "cloving/workflows/steps/handoff";
import type { Drift } from "./audit.ts";
import { ticketText } from "./ticket.ts";

export async function fileTicket(request: {
  readonly text: string;
}): Promise<string> {
  return await handoff({
    workflowId: "docs-drift",
    input: { text: request.text },
  });
}

export async function fileTickets(request: {
  readonly drifts: readonly Drift[];
  readonly commit: string;
}): Promise<readonly Drift[]> {
  const chosen = request.drifts.slice(0, 5);
  const texts = chosen.map((drift) => ticketText(drift, request.commit));
  for (let index = 0; index < 5; index += 1) {
    const text = texts.at(index);
    if (text !== undefined) await fileTicket({ text: text });
  }
  return chosen;
}
