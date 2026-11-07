import type { CycleOutcome } from "cloving/workflows";
import {
  blocked,
  failureReason,
  type GoalInput,
} from "./goal-to-tickets/effects.ts";
import { discardTree, prepareTree } from "./goal-to-tickets/tree.ts";
import { draftPlan } from "./goal-to-tickets/turn.ts";
import { postPlan } from "./goal-to-tickets/post.ts";
import { reviewByTurn as checkPlan } from "./goal-to-tickets/review.ts";
import { queueReady as nextTickets } from "./goal-to-tickets/queue.ts";

export async function goalToTickets(input: GoalInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    await prepareTree(input);
    const plan = await checkPlan(input, await draftPlan(input));
    await discardTree(input);
    return await nextTickets(input, await postPlan(input, plan));
  } catch (error) {
    return blocked(input, failureReason(error));
  }
}
