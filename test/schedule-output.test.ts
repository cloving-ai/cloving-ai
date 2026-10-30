import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered } from "../src/cli/render.ts";
import { eventually } from "./service-fixture.ts";
import {
  notifyReply,
  notificationJournal,
  withNotifier,
  withNotificationEnvironment,
} from "./notify-check-fixture.ts";

await test("CLV-242 schedule text shows active run identities and empty lists", () => {
  const schedule = {
    workflowId: "review",
    everySeconds: 300,
    state: "active",
    nextAt: 300000,
    failuresInRow: 1,
    lastSlot: 2,
    activeRunId: "run-two",
  };
  const output = rendered({ kind: "schedules", schedules: [schedule] });
  assert.match(
    output,
    /review.*300.*active.*1970-01-01T00:05:00.000Z.*1 failures.*slot 2.*active run run-two/,
  );
  for (const schedules of [[], null])
    assert.equal(
      rendered({ kind: "schedules", schedules }),
      "Schedules:\n  none\n",
    );
});

await test("CLV-242 text rendering tolerates a missing schedule row without an exception", () => {
  const output = rendered({ kind: "schedule", schedule: null });
  assert.match(output, /next none/);
  assert.match(output, /active run none/);
});

const stopped = {
  workflowId: "review",
  state: "stopped",
  failuresInRow: 3,
  failedRunIds: ["one", "two", "three"],
  stoppedAt: 900000,
  stoppedSlot: 3,
};

await test("CLV-242 notification discovery recovers from unavailable and invalid schedule replies", () =>
  withNotificationEnvironment(async (environment) => {
    let checks = 0;
    await withNotifier(
      {
        record: null,
        handle: (request) =>
          notifyReply(
            request.operation === "questions"
              ? { decisions: [] }
              : { runs: [], next: null },
          ),
        schedules: () => {
          checks += 1;
          if (checks <= 2)
            return Promise.resolve({
              kind: "error",
              error: {
                code:
                  checks === 1
                    ? "schedules-unavailable"
                    : "storage-unavailable",
                detail: "retry",
              },
            });
          return notifyReply({
            schedules: [
              checks === 3 ? { ...stopped, failedRunIds: [] } : stopped,
            ],
          });
        },
      },
      async (scene) => {
        await eventually(async () =>
          (await scene.notices()).length === 1 ? true : undefined,
        );
        await scene.stop();
        assert.ok(checks >= 4);
        assert.ok(
          environment.errors.some((error) =>
            error.includes("storage-unavailable"),
          ),
        );
        assert.ok(
          environment.errors.some((error) =>
            error.includes("invalid-stopped-schedule"),
          ),
        );
        const journal = await notificationJournal(scene.directory);
        assert.equal(journal.entries.length, 1);
        assert.equal(journal.entries[0]?.["key"], "schedule-stopped:review:3");
        assert.equal((await scene.notices())[0]?.["runId"], "three");
      },
    );
  }));
