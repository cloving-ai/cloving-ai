import {
  roomHold,
  workingHold,
  type HostSignals,
  type QueueHold,
  type QueueLimits,
} from "../queue-room.ts";
import type { Permit } from "../cli/workspace-permit.ts";

export interface QueueRoom {
  readonly limits: () => QueueLimits;
  readonly signals: () => Promise<HostSignals>;
  readonly waiting: () => Promise<number>;
  readonly permit?: () => Promise<Permit>;
}

export interface RoomGate {
  readonly open: (busy: number) => Promise<boolean>;
  readonly clear: () => Promise<boolean>;
  readonly release: () => void;
}

async function permitted(
  room: QueueRoom,
  granted: (release: () => void) => void,
): Promise<QueueHold | undefined> {
  const permit = await room.permit?.();
  if (permit?.kind === "held") return permit.hold;
  if (permit !== undefined) granted(permit.release);
  return undefined;
}

export function roomGate(
  room: QueueRoom,
  held: (hold: QueueHold | undefined) => Promise<void>,
): RoomGate {
  let reason: string | undefined;
  let release = (): void => undefined;
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
          : roomHold(await room.signals(), limits.room)) ??
        (await permitted(room, (granted) => {
          release = granted;
        }));
      await noted(hold);
      return hold === undefined;
    },
    clear: async () => {
      await noted(undefined);
      return false;
    },
    release: () => {
      const granted = release;
      release = () => undefined;
      granted();
    },
  };
}
