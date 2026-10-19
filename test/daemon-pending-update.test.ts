import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { selfUpdateActive } from "../tools/self-update-host.ts";
import { selfUpdater } from "../tools/self-update.ts";
import { withPendingUpdate } from "./pending-update-fixture.ts";
import { withUpdate } from "./self-update-fixture.ts";
import { eventually } from "./service-fixture.ts";

await test("CLV-138 a pending update holds submissions for 30 minutes and reports each transition once", async () => {
  const timestamp = Date.now();
  await withPendingUpdate(
    timestamp,
    async ({ counts, lines, commands, stop }) => {
      await eventually(() => (counts.scans >= 3 ? true : undefined));
      assert.equal(counts.submissions, 0);
      assert.deepEqual(lines, ["Queue holding for pending self-update\n"]);
      const now = Date.now;
      Date.now = () => timestamp + 30 * 60 * 1000;
      try {
        await eventually(() => (counts.submissions >= 3 ? true : undefined));
        await stop();
        assert.deepEqual(lines, [
          "Queue holding for pending self-update\n",
          "Queue continuing after pending self-update time limit\n",
        ]);
        assert.deepEqual(JSON.parse(await commands()), []);
      } finally {
        Date.now = now;
      }
    },
  );
});

await test("CLV-138 an older pending mark permits submissions and reports the time limit once", async () => {
  await withPendingUpdate(
    Date.now() - 31 * 60 * 1000,
    async ({ counts, lines }) => {
      await eventually(() => (counts.submissions >= 3 ? true : undefined));
      assert.deepEqual(lines, [
        "Queue continuing after pending self-update time limit\n",
      ]);
    },
  );
});

await test("CLV-138 installing removes the mark and the waiting queue submits again", async () => {
  await withUpdate(async (fixture) => {
    await withPendingUpdate(Date.now(), async (scene) => {
      await eventually(() => (scene.counts.scans >= 3 ? true : undefined));
      assert.equal(scene.counts.submissions, 0);
      const updater = selfUpdater({
        ...fixture.settings,
        directory: scene.directory,
        active: () => selfUpdateActive(scene),
      });
      assert.equal(await updater.check(), 75);
      await assert.rejects(readFile(scene.mark), { code: "ENOENT" });
      await eventually(() =>
        scene.counts.submissions >= 3 ? true : undefined,
      );
      assert.deepEqual(scene.lines, [
        "Queue holding for pending self-update\n",
      ]);
    });
  });
});
