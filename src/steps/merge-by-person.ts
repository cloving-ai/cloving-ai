import {
  mergeRequest,
  type MergeRequest,
  type MergeResult,
} from "../merge-request.ts";
import { mergeWhenGreen } from "./merge-when-green.ts";
import { waitForDecision } from "./wait-for-decision.ts";

export async function mergeByPerson(
  request: MergeRequest,
): Promise<MergeResult> {
  const { pull, check } = mergeRequest(request);
  const decision = await waitForDecision({
    gateId: `merge:${String(pull.number)}:${pull.commit}`,
    kind: "approval",
    prompt: `Merge pull request #${String(pull.number)} (${pull.url}) at commit ${pull.commit} ${check === null ? "with no local check" : `after the local check ${check}`}.`,
  });
  if (decision.decision !== "approved")
    return {
      merged: false,
      reason: "not-approved",
      output: decision.answer ?? "",
    };
  return await mergeWhenGreen({ pull, check });
}
