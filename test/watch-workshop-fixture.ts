import type { WatchModel } from "../src/cli/watch-render.ts";
import type { DailyNumbers } from "../src/report-days.ts";
import {
  decisionFor,
  draftRun,
  floorModel,
  floorRun,
  mergeRun,
  minutesBefore,
} from "./watch-floor-fixture.ts";
import { shelfModel } from "./watch-shelf-fixture.ts";

const today: DailyNumbers = {
  completed: 3,
  stopped: 1,
  costUsd: 25,
  unknownCostRuns: 0,
  costPerCompletedRunUsd: 25 / 3,
  yesterday: { completed: 1, costUsd: 8, unknownCostRuns: 0 },
  days: [
    { date: "2026-11-02", completed: 1 },
    { date: "2026-11-03", completed: 1 },
    { date: "2026-11-04", completed: 3 },
  ],
  workflows: [
    {
      workflowId: "develop-issue",
      completed: 3,
      costUsd: 25,
      unknownCostRuns: 0,
    },
  ],
};

export function workshopModel(): WatchModel {
  const model = floorModel(
    [
      floorRun("pr-583", {
        operation: "github-open-pr",
        minutes: 38,
        ticketId: "583",
        harness: "claude",
      }),
      floorRun("turn-585", {
        operation: "claude-turn",
        minutes: 3,
        ticketId: "585",
        harness: "claude",
      }),
      draftRun(12),
      mergeRun(51),
    ],
    {
      queue: {
        workflowId: "develop-issue",
        lanes: 2,
        busy: 1,
        ready: { count: 3, oldestAt: minutesBefore(42) },
      },
      decisions: [decisionFor("draft", { minutes: 12 })],
    },
  );
  return { ...model, today, completed: shelfModel().completed ?? [] };
}
