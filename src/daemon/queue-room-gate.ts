import {
  roomHold,
  workingHold,
  type HostSignals,
  type QueueHold,
  type QueueLimits,
} from "../queue-room.ts";

export interface QueueRoom {
  readonly limits: () => QueueLimits;
  readonly signals: () => Promise<HostSignals>;
  readonly waiting: () => Promise<number>;
}

export interface RoomGate {
  readonly open: (busy: number) => Promise<boolean>;
  readonly clear: () => Promise<boolean>;
}

export function roomGate(
  room: QueueRoom,
  held: (hold: QueueHold | undefined) => Promise<void>,
): RoomGate {
  let reason: string | undefined;
  const noted = async (hold: QueueHold | undefined): Promise<void> => {
    if (hold !== undefined && hold.reason !== reason)
      process.stderr.write(`Queue ${hold.text.replace(/^Held/, "held")}\n`);
    reason = hold?.reason;
    await held(hold);
  };
  return {
    open: async (busy) => {
      const limits = room.limits();
      const working =
        limits.workingLanes < limits.lanes
          ? workingHold(busy - (await room.waiting()), limits.workingLanes)
          : undefined;
      const hold =
        working ??
        (limits.room === undefined
          ? undefined
          : roomHold(await room.signals(), limits.room));
      await noted(hold);
      return hold === undefined;
    },
    clear: async () => {
      await noted(undefined);
      return false;
    },
  };
}
