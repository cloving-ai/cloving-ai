import type { Fields } from "./protocol.ts";

export function privateWorkflow(workflowId: string): boolean {
  return workflowId === "analyze-chats";
}

export function operationalDecision(
  decision: Fields,
  workflowId: string,
): Fields {
  if (!privateWorkflow(workflowId)) return decision;
  return {
    ...decision,
    prompt: "Private analysis question. Run cloving questions to view it.",
    context: [],
    feedback: [],
  };
}
