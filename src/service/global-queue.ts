import { record, type Fields } from "../protocol.ts";
import { maximumQueueLanes } from "../queue-room.ts";
import { queueRun } from "./queue-spend.ts";
import { failed, type ServiceContext } from "./replies.ts";

async function occupancy(context: ServiceContext) {
  const state = await context.authority.state();
  const active = Object.values(state.runs).filter(
    (run) => !["completed", "failed", "cancelled"].includes(run.status),
  );
  const queued = await Promise.all(
    active.map(async (run) =>
      (await queueRun(context, run.runId)) ? [run] : [],
    ),
  );
  const work = await context.queueSettings?.work?.();
  const working = queued.flat().filter((run) => {
    if (work?.working.includes(run.runId) === true) return true;
    if (
      work?.github.includes(run.runId) === true ||
      ["waiting_gate", "paused"].includes(run.status)
    )
      return false;
    return state.details[run.runId]?.observation?.condition !== "waiting-run";
  });
  return { busy: queued.flat().length, working: working.length };
}

export async function globalQueueRefusal(
  context: ServiceContext,
  identity: Fields,
) {
  const limits = context.queueSettings?.global?.() ?? {};
  const lanes = limits.lanes ?? maximumQueueLanes;
  const counts = await occupancy(context);
  if (counts.busy >= lanes)
    return failed("queue-repository-full", {
      ...identity,
      detail: `${String(counts.busy)} of ${String(lanes)} global queue lanes busy`,
    });
  const working = limits.workingLanes;
  if (working !== undefined && counts.working >= working)
    return failed("queue-global-working-full", {
      ...identity,
      detail: `${String(counts.working)} of ${String(working)} global active-work lanes busy. Waiting runs retain their total lane.`,
    });
  return undefined;
}

function effectiveLimits(context: ServiceContext): Fields {
  const limits = context.queueSettings?.global?.() ?? {};
  const lanes = limits.lanes ?? maximumQueueLanes;
  return {
    lanes,
    configuredLanes: limits.lanes ?? null,
    workingLanes: limits.workingLanes ?? lanes,
    configuredWorkingLanes: limits.workingLanes ?? null,
    sources: limits.sources ?? { lanes: "default", workingLanes: "default" },
  };
}

export async function globalOverview(
  context: ServiceContext,
  queues: readonly unknown[],
): Promise<Fields> {
  const states = queues.map(record).map((queue) => queue?.["state"]);
  const state =
    ["running", "draining", "stopped", "drained", "off"].find((value) =>
      states.includes(value),
    ) ?? "unavailable";
  return {
    state,
    ...(await occupancy(context)),
    ...effectiveLimits(context),
    eligible: states.some((value) => value !== "off" && value !== undefined),
  };
}
