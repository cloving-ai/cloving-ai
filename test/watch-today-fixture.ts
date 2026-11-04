import type { Fields } from "../src/protocol.ts";

export type TodayEnd =
  "completed" | "partial" | "blocked" | "failed" | "cancelled";

export interface TodayRunFields {
  readonly status: Fields;
  readonly events: readonly Fields[];
}

const ends: Readonly<Record<TodayEnd, Fields>> = {
  completed: {
    type: "run.completed",
    condition: "completed",
    payload: { outcome: "handoff_requested", ticketStatus: "complete" },
  },
  partial: {
    type: "run.completed",
    condition: "completed",
    payload: { outcome: "handoff_requested", ticketStatus: "partial" },
  },
  blocked: {
    type: "run.completed",
    condition: "completed",
    payload: { outcome: "blocked" },
  },
  failed: { type: "run.failed", condition: "failed", payload: {} },
  cancelled: { type: "run.cancelled", condition: "cancelled", payload: {} },
};

export function localTime(day: number, hour: number): number {
  return new Date(2026, 10, day, hour).getTime();
}

export function endedRun(
  runId: string,
  options: {
    readonly end: TodayEnd;
    readonly at: number;
    readonly workflowId?: string;
    readonly costs?: readonly (number | null)[];
  },
): TodayRunFields {
  const end = ends[options.end];
  const recordedAt = new Date(options.at).toISOString();
  return {
    status: {
      runId,
      workflowId: options.workflowId ?? "develop-issue",
      ticketId: null,
      state: end["condition"],
      condition: end["condition"],
      latestSequence: 2,
      latestAt: recordedAt,
      effects: [],
      workerTurns: (options.costs ?? []).map((costUsd, index) => ({
        operationId: `${runId}-turn-${String(index + 1)}`,
        costUsd,
      })),
    },
    events: [
      {
        runId,
        sequence: 1,
        type: "run.created",
        recordedAt: new Date(options.at - 3_600_000).toISOString(),
        payload: {},
      },
      {
        runId,
        sequence: 2,
        type: end["type"],
        recordedAt,
        payload: end["payload"],
      },
    ],
  };
}

export function activeRun(
  runId: string,
  options: { readonly at: number; readonly costs: readonly number[] },
): TodayRunFields {
  return {
    status: {
      runId,
      workflowId: "develop-issue",
      ticketId: null,
      state: "running",
      condition: "running",
      latestSequence: 1,
      latestAt: new Date(options.at).toISOString(),
      effects: [],
      workerTurns: options.costs.map((costUsd, index) => ({
        operationId: `${runId}-turn-${String(index + 1)}`,
        costUsd,
      })),
    },
    events: [
      {
        runId,
        sequence: 1,
        type: "run.created",
        recordedAt: new Date(options.at).toISOString(),
        payload: {},
      },
    ],
  };
}

export function threeDayRuns(): readonly TodayRunFields[] {
  return [
    endedRun("today-1", {
      end: "completed",
      at: localTime(4, 9),
      costs: [4, 6],
    }),
    endedRun("today-2", {
      end: "completed",
      at: localTime(4, 11),
      costs: [12.5],
    }),
    endedRun("today-3", {
      end: "completed",
      at: localTime(4, 0),
      workflowId: "idea",
      costs: [0.5],
    }),
    endedRun("today-4", { end: "failed", at: localTime(4, 13), costs: [2] }),
    endedRun("yesterday-1", {
      end: "completed",
      at: localTime(3, 23) + 59 * 60_000,
      costs: [7],
    }),
    endedRun("yesterday-2", {
      end: "partial",
      at: localTime(3, 10),
      costs: [1],
    }),
    endedRun("yesterday-3", { end: "cancelled", at: localTime(3, 8) }),
    endedRun("older-1", { end: "completed", at: localTime(2, 15), costs: [3] }),
    endedRun("older-2", { end: "blocked", at: localTime(2, 16), costs: [5] }),
    activeRun("active-1", { at: localTime(4, 14), costs: [9] }),
  ];
}
