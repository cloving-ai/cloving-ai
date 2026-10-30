import assert from "node:assert/strict";
import { test } from "node:test";
import { eventually } from "./service-fixture.ts";
import {
  notifyReply,
  notificationJournal,
  withNotifier,
} from "./notify-check-fixture.ts";

await test("CLV-242 one schedule stop is delivered once, including notify startup and restart", () => {
  let checks = 0;
  return withNotifier(
    {
      record: null,
      handle: (request) =>
        notifyReply(
          request.operation === "questions"
            ? { decisions: [] }
            : { runs: [], next: null },
        ),
      schedules: (request) => {
        checks += 1;
        assert.deepEqual(request.parameters, { action: "list" });
        return notifyReply({
          schedules: [
            {
              workflowId: "review-queue",
              state: "stopped",
              failuresInRow: 3,
              failedRunIds: ["one", "two", "three"],
              stoppedAt: 900000,
              stoppedSlot: 3,
            },
          ],
        });
      },
    },
    async (scene) => {
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      await scene.stop();
      const notices = await scene.notices();
      const notice = notices[0];
      assert.ok(notice);
      assert.equal(notice["event"], "schedule-stopped");
      assert.equal(notice["runId"], "three");
      assert.deepEqual(notice["failedRunIds"], ["one", "two", "three"]);
      assert.match(
        String(notice["body"]),
        /cloving schedule resume review-queue$/,
      );
      const before = checks;
      await scene.restart();
      await eventually(() => (checks > before ? true : undefined));
      await scene.stop();
      assert.deepEqual(await scene.notices(), notices);
      const journal = await notificationJournal(scene.directory);
      const entry = journal.entries[0];
      assert.ok(entry);
      assert.equal(entry["key"], "schedule-stopped:review-queue:3");
      assert.equal(entry["state"], "sent");
    },
  );
});
