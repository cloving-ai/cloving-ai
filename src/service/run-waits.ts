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

async function settled(
  authority: Authority,
  run: { readonly runId: string; readonly status: string },
): Promise<boolean> {
  if (run.status !== "cancelled")
    return ["completed", "failed"].includes(run.status);
  const closure = await authority.effects.closure(run.runId);
  return (
    !closure.open &&
    closure.closure === "cancelled" &&
    closure.unresolved.length === 0
  );
}

export async function runWaitTarget(
  authority: Authority,
  runId: string,
): Promise<RunWaitTarget | undefined> {
  const run = await authority.queries.run(runId);
  const origin = (await authority.queries.runOrigins())[runId];
  if (run === undefined || origin === undefined) return undefined;
  const terminal = await settled(authority, run);
  const event = terminal
    ? await authority.queries.latestCompletion({
        runId,
        atOrBefore: run.sequence,
        terminal: true,
      })
    : undefined;
  const endedAt = event === undefined ? null : Date.parse(event.recordedAt);
  const stoppedAt =
    run.status === "cancelled" && terminal
      ? await authority.effects.settledAt(runId)
      : null;
  return {
    parentRunId: origin.parentRunId,
    status: run.status,
    endedAt: endedAt === null ? null : Math.max(endedAt, stoppedAt ?? endedAt),
    outcome: outcomeOf(event, run.status),
  };
}
