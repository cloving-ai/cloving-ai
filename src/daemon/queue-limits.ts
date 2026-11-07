import type { QueueLimits } from "../queue-room.ts";

export interface QueueLimitsSource {
  readonly current: () => QueueLimits;
  readonly replace: (next: QueueLimits) => void;
}

export function queueLimitsSource(settings: {
  readonly queueLanes?: number;
  readonly queueLimits?: QueueLimits;
}): QueueLimitsSource {
  const lanes = settings.queueLanes ?? 1;
  let current = settings.queueLimits ?? { lanes, workingLanes: lanes };
  return {
    current: () => current,
    replace: (next) => {
      current = next;
    },
  };
}
