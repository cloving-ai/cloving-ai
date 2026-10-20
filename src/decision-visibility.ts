import type { Fields } from "./protocol.ts";

export function operationalDecision(
  decision: Fields,
  workflowId: string,
): Fields {
  if (workflowId !== "analyze-chats") return decision;
  return {
    ...decision,
    prompt: "Private analysis question. Run cloving questions to view it.",
    context: [],
    feedback: [],
  };
}
