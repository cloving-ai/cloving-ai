import type { CycleOutcome } from "cloving/workflows";
import {
  blocked,
  failureReason,
  type ChecksInput,
} from "./review-checks/input.ts";
import { checkIssue } from "./review-checks/issue.ts";
import { checksPass } from "./review-checks/pass.ts";

export async function reviewChecks(
  request: ChecksInput,
): Promise<CycleOutcome> {
  "use workflow";
  try {
    const text = request.input.text;
    if (text !== undefined)
      return await checkIssue({ cycleId: request.cycleId, text: text });
    return await checksPass(request);
  } catch (error) {
    return blocked(request, failureReason(error));
  }
}
