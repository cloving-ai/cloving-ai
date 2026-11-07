import type { CycleOutcome } from "cloving/workflows";
import {
  blocked,
  failureReason,
  type TriageInput,
} from "./triage-issue/input.ts";
import { triagePass } from "./triage-issue/pass.ts";
import { discardTree, triageTurn } from "./triage-issue/turn.ts";
import { askPerson as decidePost } from "./triage-issue/post.ts";

export async function triageIssue(request: TriageInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    const issue = request.input.issue;
    if (issue === undefined) return await triagePass(request);
    const task = { cycleId: request.cycleId, issue: issue };
    const outcome = await decidePost(await triageTurn(task));
    await discardTree(task);
    return outcome;
  } catch (error) {
    return blocked(request, failureReason(error));
  }
}
