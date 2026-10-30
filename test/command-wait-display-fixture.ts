import { call, field, fields, type Harness } from "./service-fixture.ts";
import type { CommandWaitView } from "../src/authority/command-wait-view.ts";
import { boardModel } from "./watch-board-fixture.ts";

export const shownWait: CommandWaitView = {
  name: "team-review",
  command: "review-state",
  state: "waiting",
  maximumWaitSeconds: 2_592_000,
  startedAt: "2026-10-09T00:00:00.000Z",
  deadline: "2026-11-08T00:00:00.000Z",
  nextCheckAt: "2026-10-14T01:00:00.000Z",
  checkCount: 120,
  remainingSeconds: 2_160_000,
  reason: null,
};

export function waitModel(wait: CommandWaitView = shownWait) {
  return boardModel(
    [
      {
        status: {
          runId: "run-1",
          workflowId: "review-queue",
          state: "running",
          latestAt: shownWait.startedAt,
          budget: { spent: 1, limit: 2 },
          commandWaits: [
            {
              ...wait,
              input: "browser-input-fixture",
              stdout: "browser-stdout-fixture",
              stderr: "browser-stderr-fixture",
              result: "browser-output-fixture",
            },
          ],
        },
        events: [],
      },
    ],
    { workflows: ["review-queue"], updatedAt: "2026-10-14T00:00:00.000Z" },
  );
}

export async function readWaitStatus(harness: Harness, runId: string) {
  return fields(
    field(
      await call(harness, { operation: "status", parameters: { runId } }),
      "run",
    ),
  );
}
