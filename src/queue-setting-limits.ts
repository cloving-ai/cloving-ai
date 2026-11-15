import type { QueueLimits, GlobalQueueLimits } from "./queue-room.ts";
import type { QueueSettingRequest } from "./queue-setting-operation.ts";

interface Selection {
  readonly next: QueueLimits;
  readonly request: QueueSettingRequest;
}

function globalPair(limits: GlobalQueueLimits | undefined): QueueLimits {
  return {
    lanes: limits?.lanes ?? 16,
    workingLanes: limits?.workingLanes ?? limits?.lanes ?? 16,
    ...(limits?.sources === undefined ? {} : { sources: limits.sources }),
  };
}

function requestedValue({ next, request }: Selection): boolean {
  if (request.action === "set") return next[request.field] === request.value;
  return next.sources?.[request.field].includes("private file") !== true;
}

function followsTotal(current: QueueLimits): boolean {
  return (
    current.sources?.workingLanes === "default" ||
    (current.sources === undefined && current.workingLanes === current.lanes)
  );
}

function loweredExplicitCap(
  current: QueueLimits,
  workingLanes: number,
): boolean {
  return !followsTotal(current) && workingLanes < current.workingLanes;
}

function loweredGlobalCap(current: QueueLimits, pair: QueueLimits): boolean {
  return (
    current.global?.workingLanes !== undefined &&
    pair.workingLanes < globalPair(current.global).workingLanes
  );
}

function selectedSources(
  current: QueueLimits,
  change: Selection & { readonly workingLanes: number },
): QueueLimits["sources"] {
  const { next, request, workingLanes } = change;
  if (current.sources === undefined && next.sources === undefined)
    return undefined;
  const lanes = request.field === "lanes" ? next : current;
  const working =
    request.field === "workingLanes" ||
    loweredExplicitCap(current, workingLanes)
      ? next
      : current;
  return {
    lanes: lanes.sources?.lanes ?? "default",
    workingLanes: working.sources?.workingLanes ?? "default",
  };
}

function selectedPair(
  current: QueueLimits,
  change: Selection,
): QueueLimits | undefined {
  const { next, request } = change;
  if (!requestedValue(change)) return undefined;
  const workingLanes =
    request.field === "workingLanes"
      ? next.workingLanes
      : Math.min(
          next.lanes,
          followsTotal(current) ? next.lanes : current.workingLanes,
        );
  const lanes = request.field === "lanes" ? next.lanes : current.lanes;
  if (lanes !== next.lanes || workingLanes !== next.workingLanes)
    return undefined;
  const sources = selectedSources(current, { ...change, workingLanes });
  return {
    ...current,
    lanes,
    workingLanes,
    ...(sources === undefined ? {} : { sources }),
  };
}

function selectedGlobal(
  current: QueueLimits,
  change: Selection & { readonly pair: QueueLimits },
): GlobalQueueLimits {
  const { next, request, pair } = change;
  const previous = current.global ?? {};
  const incoming = next.global ?? {};
  const lanes = request.field === "lanes" ? incoming.lanes : previous.lanes;
  const workingLanes =
    request.field === "workingLanes" || loweredGlobalCap(current, pair)
      ? incoming.workingLanes
      : previous.workingLanes;
  return {
    ...(lanes === undefined ? {} : { lanes }),
    ...(workingLanes === undefined ? {} : { workingLanes }),
    ...(pair.sources === undefined ? {} : { sources: pair.sources }),
  };
}

export function selectedQueueLimits(
  current: QueueLimits,
  change: Selection,
): QueueLimits | undefined {
  const { request, next } = change;
  if (request.scope === "workflow") return selectedPair(current, change);
  const pair = selectedPair(globalPair(current.global), {
    next: globalPair(next.global),
    request,
  });
  if (pair === undefined) return undefined;
  return { ...current, global: selectedGlobal(current, { ...change, pair }) };
}
