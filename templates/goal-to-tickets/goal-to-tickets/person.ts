import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import type { GoalInput } from "./effects.ts";
import { dependencyLines, type Draft } from "./plan.ts";
import type { PlannedGoal } from "./turn.ts";

function draftLine(draft: Draft): string {
  const needs = dependencyLines(draft.lines)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("; ");
  return `Draft ${String(draft.number)}: ${draft.title}. Dependencies: ${needs === "" ? "none" : needs}`;
}

export function planPrompt(plan: PlannedGoal): string {
  return [
    `Post these ${String(plan.order.length)} tickets in this order? A denial posts nothing.`,
    plan.order.map(draftLine).join("\n"),
    plan.text,
  ].join("\n\n");
}

export async function reviewByPerson(
  input: GoalInput,
  plan: PlannedGoal,
): Promise<PlannedGoal> {
  const decision = await waitForDecision({
    gateId: `plan:${input.cycleId}:${plan.digest}`,
    kind: "approval",
    prompt: planPrompt(plan),
  });
  if (decision.decision !== "approved") throw new Error("plan-not-approved");
  return plan;
}
