import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import {
  effectResult,
  resultFields,
  type GoalInput,
  type Ticket,
} from "./effects.ts";
import { ticketText, type Draft } from "./plan.ts";
import type { PlannedGoal } from "./turn.ts";

interface PostRequest {
  readonly input: GoalInput;
  readonly draft: Draft;
  readonly tickets: readonly Ticket[];
}

export async function postDraft(request: PostRequest): Promise<Ticket> {
  const { input, draft, tickets } = request;
  const fields = resultFields(
    effectResult(
      await protectedEffect({
        capability: "github",
        method: "create-issue",
        scope: { phase: "goal", operation: "post", round: draft.number },
        target: `${input.cycleId}:draft-${String(draft.number)}`,
        units: 1,
        payload: JSON.stringify({ text: ticketText(draft, tickets) }),
      }),
    ),
  );
  const number = fields["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("invalid-github-result");
  return {
    draft: draft.number,
    number: number,
    title: draft.title,
    ready: draft.blockers.length === 0 && !draft.outside,
  };
}

export async function postPlan(
  input: GoalInput,
  plan: PlannedGoal,
): Promise<readonly Ticket[]> {
  let tickets: readonly Ticket[] = [];
  for (let index = 0; index < 12; index += 1) {
    const draft = plan.order.at(index);
    if (draft !== undefined)
      tickets = tickets.concat(
        await postDraft({ input: input, draft: draft, tickets: tickets }),
      );
  }
  return tickets;
}
