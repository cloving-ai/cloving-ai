import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  recordRetention,
  retentionIntervalMilliseconds,
} from "../src/daemon/record-sweep.ts";
import { withSweep } from "./record-sweep-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

async function reached(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + testMilliseconds(5000);
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition-not-reached");
    await delay(10);
  }
}

await test("CLV-270 the retention loop repeats its pass once each hour", () => {
  assert.equal(retentionIntervalMilliseconds, 3_600_000);
});

await test("CLV-270 the retention loop sweeps at its start and again after each interval", () =>
  withSweep(async (scene) => {
    await scene.folder("journal/a", { runId: "done" });
    const loop = await recordRetention({
      ...scene.settings(),
      intervalMilliseconds: 20,
    });
    try {
      assert.equal(existsSync(join(scene.root, "archive/journal/a")), true);
      assert.equal(scene.lines.length, 1);
      await scene.folder("github/b", { runId: "done" });
      await reached(() => existsSync(join(scene.root, "archive/github/b")));
    } finally {
      await loop.stop();
    }
    const passes = scene.lines.length;
    await delay(60);
    assert.equal(scene.lines.length, passes);
  }));

await test("CLV-270 a pass that fails logs the reason and does not stop the daemon", () =>
  withSweep(async (scene) => {
    await scene.folder("journal/a", { runId: "done" });
    const loop = await recordRetention(
      scene.settings({
        runs: () => Promise.reject(new Error("authority-closed")),
      }),
    );
    await loop.stop();
    assert.equal(existsSync(join(scene.root, "journal/a/started.json")), true);
    assert.deepEqual(scene.lines, ["retention: failed (authority-closed)\n"]);
  }));
