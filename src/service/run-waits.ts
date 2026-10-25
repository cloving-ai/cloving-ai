import type { Authority } from "../broker/actor/authority.ts";
import type { PublishedEvent } from "../broker/actor/authority-queries.ts";
import type { RunWaitTarget } from "../run-wait.ts";
import type { RunWaitOutcome } from "../step-bridge.ts";

function outcomeOf(
  event: PublishedEvent | undefined,
  status: string,
): RunWaitOutcome | null {
  if (event === undefined) return null;
  return {
    kind: event.payload["outcome"] ?? status,
    reason: event.payload["outcomeReason"] ?? null,
    promotionId: event.payload["promotionId"] ?? null,
  };
}

export async function runWaitTarget(
  authority: Authority,
  runId: string,
): Promise<RunWaitTarget | undefined> {
  const state = await authority.state();
  const run = state.runs[runId];
  const origin = (await authority.queries.runOrigins())[runId];
  if (run === undefined || origin === undefined) return undefined;
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  const event = terminal
    ? await authority.queries.latestCompletion({
        runId,
        atOrBefore: state.sequence,
        terminal: true,
      })
    : undefined;
  return {
    parentRunId: origin.parentRunId,
    status: run.status,
    endedAt: event === undefined ? null : Date.parse(event.recordedAt),
    outcome: outcomeOf(event, run.status),
  };
}
