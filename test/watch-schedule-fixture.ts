import type { ShownSchedule } from "../src/cli/schedule-render.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";

export const activeSchedule: ShownSchedule = {
  workflowId: "review-queue",
  everySeconds: 300,
  state: "active",
  failuresInRow: 0,
  nextAt: Date.parse(boardTime) + 300000,
  stoppedAt: null,
};

export function scheduleModel(schedule: ShownSchedule = activeSchedule) {
  return boardModel(
    [
      {
        status: {
          runId: "scheduled-run",
          workflowId: "review-queue",
          state: "running",
          latestAt: boardTime,
          scheduled: { slot: 12 },
        },
        events: [],
      },
      {
        status: {
          runId: "manual-run",
          workflowId: "review-queue",
          state: "running",
          latestAt: boardTime,
        },
        events: [],
      },
    ],
    { workflows: ["review-queue", "manual-only"], schedules: [schedule] },
  );
}
