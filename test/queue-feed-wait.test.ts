import assert from "node:assert/strict";
import { test } from "node:test";
import { field, text, withHarness } from "./service-fixture.ts";
import { queuedFeed } from "./queue-feed-fixture.ts";

for (const interval of [1000, 300_000]) {
  await test(`CLV-362 empty results wait four intervals capped at fifteen minutes for ${String(interval)}`, () =>
    withHarness(async (harness) => {
      let now = 1_000_000;
      const fixture = await queuedFeed(harness, { interval, clock: () => now });
      let feed = await fixture.load();
      await feed.next(fixture.attempt);
      const first = text(await fixture.progress(), "commandId");
      await fixture.complete({ picks: [], skipped: [] });
      await feed.next(fixture.attempt);
      const nextAt = now + Math.min(interval * 4, 900_000);
      assert.equal(field(await fixture.progress(), "notBefore"), nextAt);
      feed = await fixture.load();
      now = nextAt - 1;
      await feed.next(fixture.attempt);
      assert.equal(field(await fixture.progress(), "commandId"), undefined);
      now = nextAt;
      await feed.next(fixture.attempt);
      assert.notEqual(text(await fixture.progress(), "commandId"), first);
      assert.equal(fixture.shown.length, 2);
    }));
}
