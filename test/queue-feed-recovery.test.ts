import assert from "node:assert/strict";
import { test } from "node:test";
import { runIdentity } from "../src/service/submission-handler.ts";
import { call, field, items, text, withHarness } from "./service-fixture.ts";
import { queuedFeed } from "./queue-feed-fixture.ts";

for (const ending of ["failed", "invalid-result"]) {
  await test(`CLV-362 a ${ending} feed retires its command before a restarted queue retries`, () =>
    withHarness(async (harness) => {
      const fixture = await queuedFeed(harness);
      let feed = await fixture.load();
      await feed.next(fixture.attempt);
      const commandId = text(await fixture.progress(), "commandId");
      if (ending === "failed") {
        await fixture.service.worker.failed({
          runId: runIdentity(commandId),
          commandId: "failed",
          expectedRevision: 1,
        });
      } else {
        await fixture.complete({
          picks: [{ id: "bad id", text: "Invalid" }],
          skipped: [],
        });
      }
      const reason =
        ending === "failed" ? "queue-feed-failed" : "invalid-feed-result";
      await assert.rejects(feed.next(fixture.attempt), { message: reason });
      assert.equal(field(await fixture.progress(), "commandId"), undefined);
      assert.deepEqual(
        (await call(harness, { operation: "status", parameters: {} }))["runs"],
        [],
      );
      feed = await fixture.load();
      await feed.next(fixture.attempt);
      assert.notEqual(text(await fixture.progress(), "commandId"), commandId);
      const pick = { id: "900", text: "Recovered" };
      await fixture.complete({ picks: [pick], skipped: [] });
      await feed.next(fixture.attempt);
      const status = await call(harness, {
        operation: "status",
        parameters: {},
      });
      assert.deepEqual(
        items(status["runs"]).map((run) => field(run, "input")),
        [{ ticket: pick }],
      );
    }));
}
