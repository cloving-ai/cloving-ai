import { record, type Fields, type Reply } from "./protocol.ts";

export type SchedulePort = (parameters: Fields) => Promise<Reply>;

export type PendingSlot =
  | { readonly kind: "run"; readonly input: Fields }
  | { readonly kind: "skip"; readonly runId: string };

export interface ScheduleStop {
  readonly stoppedAt: number;
  readonly stoppedSlot: number;
  readonly failedRunIds: readonly string[];
}

export interface ScheduleProgress {
  readonly everySeconds: number;
  readonly nextAt: number;
  readonly lastSlot: number;
  readonly state: "active" | "paused" | "stopped";
  readonly failuresInRow: number;
  readonly failedRunIds: readonly string[];
  readonly stoppedAt?: number;
  readonly stoppedSlot?: number;
  readonly stops?: readonly ScheduleStop[];
  readonly activeCommandId?: string;
  readonly pending?: PendingSlot;
}

export function scheduleStops(
  progress: ScheduleProgress,
): readonly ScheduleStop[] {
  if (progress.stops !== undefined) return progress.stops;
  if (
    progress.state !== "stopped" ||
    progress.stoppedAt === undefined ||
    progress.stoppedSlot === undefined
  )
    return [];
  return [
    {
      stoppedAt: progress.stoppedAt,
      stoppedSlot: progress.stoppedSlot,
      failedRunIds: progress.failedRunIds,
    },
  ];
}

export function finishedScheduleRun(
  progress: ScheduleProgress,
  run: {
    readonly runId: string;
    readonly status: Fields;
    readonly now: number;
  },
): ScheduleProgress {
  const rest = { ...progress };
  delete rest.activeCommandId;
  const state = run.status["state"];
  if (state === "cancelled") return rest;
  const failed =
    state === "failed" || record(run.status["outcome"])?.["kind"] === "blocked";
  if (!failed) return { ...rest, failuresInRow: 0, failedRunIds: [] };
  const failedRunIds = [...progress.failedRunIds, run.runId];
  const failuresInRow = failedRunIds.length;
  const stop = {
    stoppedAt: run.now,
    stoppedSlot: progress.lastSlot,
    failedRunIds,
  };
  return {
    ...rest,
    failedRunIds,
    failuresInRow,
    ...(failuresInRow < 3
      ? {}
      : {
          state: "stopped",
          ...stop,
          stops: [...scheduleStops(progress), stop],
        }),
  };
}
