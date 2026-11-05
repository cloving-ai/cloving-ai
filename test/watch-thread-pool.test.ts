import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { threadPoolStallExitCode } from "../src/thread-pool-check.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { fields } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { directWatch } from "./watch-direct-fixture.ts";

const timing = { intervalMilliseconds: 20, deadlineMilliseconds: 100 };

await test("CLV-298 the watch server logs threadpool-stalled with resource counts, closes and ends with the stall exit code", () =>
  withFiles({}, async (root) => {
    const pool = { stalled: false };
    const watch = await directWatch(join(root, "run"), {
      threadPool: {
        ...timing,
        check: () =>
          pool.stalled ? new Promise(() => undefined) : Promise.resolve(),
      },
    });
    pool.stalled = true;
    try {
      const status = await Promise.race([
        watch.finished,
        delay(testMilliseconds(5000), "running"),
      ]);
      assert.equal(status, threadPoolStallExitCode);
      assert.equal(watch.complaints.length, 1);
      assert.match(
        watch.complaints[0] ?? "",
        /^threadpool-stalled ms=\d+ resources=\S*Timeout:\d+\S*\n$/,
      );
      await assert.rejects(
        fetch(watch.address, {
          signal: AbortSignal.timeout(testMilliseconds(5000)),
        }),
        /fetch failed/,
      );
    } finally {
      await watch.stop();
    }
  }));

await test("CLV-298 the watch health route gives the latest pool check from memory", () =>
  withFiles({}, async (root) => {
    const watch = await directWatch(join(root, "run"), {
      threadPool: { ...timing, check: () => Promise.resolve() },
    });
    try {
      const reply = await fetch(`${watch.address}health.json`);
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get("content-type"), "application/json");
      assert.equal(reply.headers.get("cache-control"), "no-store");
      const health = fields(JSON.parse(await reply.text()));
      assert.deepEqual(Object.keys(health), ["threadPool"]);
      const check = fields(health["threadPool"]);
      assert.equal(check["result"], "ok");
      assert.equal(typeof check["checkedAt"], "string");
      assert.equal(typeof check["milliseconds"], "number");
      assert.deepEqual(watch.complaints, []);
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));
