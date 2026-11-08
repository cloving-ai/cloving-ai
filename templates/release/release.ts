import type { CycleOutcome } from "cloving/workflows";
import { releaseTask, type ReleaseInput } from "./release/input.ts";
import { blocked, failureReason } from "./release/outcome.ts";
import { askPerson as approvePublish } from "./release/publish.ts";
import { waitForPulls } from "./release/pulls.ts";
import { deliverVersion, unmerged } from "./release/round.ts";
import { pushTag, releaseStatus } from "./release/tag.ts";
import { prepareRelease } from "./release/version.ts";

export async function release(request: ReleaseInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    const task = releaseTask(request);
    const waited = await waitForPulls(task);
    if (waited !== null) return waited;
    const base = await prepareRelease(task);
    const last = await deliverVersion({ task, base });
    if (last.step !== "merged") return unmerged({ task, last });
    const approved = await approvePublish({ task, pull: last.pull });
    if ("kind" in approved) return approved;
    const tagged = await pushTag(approved);
    return await releaseStatus(tagged);
  } catch (error) {
    return blocked({
      cycleId: request.cycleId,
      reason: failureReason(error),
      evidenceId: "release",
    });
  }
}
