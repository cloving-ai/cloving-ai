import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { reached, withScheduler } from "./workflow-scheduler-fixture.ts";
import { eventually } from "./service-fixture.ts";
import {
  notifyReply,
  notificationJournal,
  withNotifier,
} from "./notify-check-fixture.ts";

const stoppedSchedule: Parameters<typeof withScheduler>[0] = {
  initial: {
    review: {
      everySeconds: 300,
      nextAt: 1200000,
      lastSlot: 3,
      state: "stopped",
      failuresInRow: 3,
      failedRunIds: ["one", "two", "three"],
      stoppedAt: 900000,
      stoppedSlot: 3,
    },
  },
  handle: () =>
    Promise.resolve({
      kind: "result",
      result: { run: { state: "failed" } },
    }),
};

await test("CLV-242 resumed stops stay deliverable with distinct keys after notify restart", () =>
  withScheduler(stoppedSchedule, async (scheduler) => {
    scheduler.now(900000);
    await scheduler.control({ action: "pause", workflowId: "review" });
    await scheduler.restart();
    await scheduler.control({ action: "resume", workflowId: "review" });
    const first = await scheduler.control({ action: "list" });
    assert.equal(first.kind, "result");
    const firstRows = first.result["schedules"];
    assert.ok(Array.isArray(firstRows));
    assert.equal(record(firstRows[0])?.["state"], "active");
    const firstStops = record(firstRows[0])?.["stops"];
    assert.ok(Array.isArray(firstStops));
    assert.equal(firstStops.length, 1);
    for (let slot = 4; slot <= 6; slot += 1) {
      scheduler.now(slot * 300000);
      await reached(
        async () =>
          record(record(JSON.parse(await scheduler.saved()))?.["review"])?.[
            "failuresInRow"
          ] ===
          slot - 3,
      );
    }
    await scheduler.control({ action: "resume", workflowId: "review" });
    const listed = await scheduler.control({ action: "list" });
    await withNotifier(
      {
        record: null,
        handle: (request) =>
          notifyReply(
            request.operation === "questions"
              ? { decisions: [] }
              : { runs: [], next: null },
          ),
        schedules: () => Promise.resolve(listed),
      },
      async (notifier) => {
        await eventually(async () =>
          (await notifier.notices()).length === 2 ? true : undefined,
        );
        await notifier.stop();
        const notices = await notifier.notices();
        assert.equal(notices[0]?.["event"], "schedule-stopped");
        assert.equal(notices[1]?.["event"], "schedule-stopped");
        await notifier.restart();
        await notifier.stop();
        assert.deepEqual(await notifier.notices(), notices);
        assert.deepEqual(
          (await notificationJournal(notifier.directory)).entries.map(
            (entry) => entry["key"],
          ),
          ["schedule-stopped:review:3", "schedule-stopped:review:6"],
        );
      },
    );
  }));
