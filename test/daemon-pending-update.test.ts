import assert from "node:assert/strict";
import filesystem, { readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { selfUpdateActive } from "../tools/self-update-host.ts";
import { selfUpdater } from "../tools/self-update.ts";
import { withPendingUpdate } from "./pending-update-fixture.ts";
import { withUpdate } from "./self-update-fixture.ts";
import { eventually } from "./service-fixture.ts";

function pausedAdmission(directory: string) {
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const write = filesystem.writeFile;
  let paused = false;
  filesystem.writeFile = async (file, data) => {
    if (file === join(directory, "queue-submission") && !paused) {
      paused = true;
      reached.resolve(undefined);
      await release.promise;
    }
    await write(file, data);
  };
  syncBuiltinESMExports();
  return {
    reached,
    release,
    restore: () => {
      filesystem.writeFile = write;
      syncBuiltinESMExports();
    },
  };
}

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
        const journal: unknown = JSON.parse(await commands());
        assert.ok(
          journal && typeof journal === "object" && "commands" in journal,
        );
        assert.deepEqual(journal.commands, []);
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

await test("CLV-138 the queue rechecks a hold published after its first check", async () => {
  await withUpdate(async (fixture) => {
    await withPendingUpdate(Date.now(), async (scene) => {
      const admission = pausedAdmission(scene.directory);
      const stopping = Promise.withResolvers<undefined>();
      const stopped = Promise.withResolvers<undefined>();
      let updating: Promise<number | undefined> | undefined;
      try {
        await rm(scene.mark);
        await admission.reached.promise;
        const updater = selfUpdater({
          ...fixture.settings,
          directory: scene.directory,
          active: () => selfUpdateActive(scene),
          stop: async () => {
            stopping.resolve(undefined);
            await stopped.promise;
          },
        });
        updating = updater.check();
        await stopping.promise;
        const scans = scene.counts.scans;
        admission.release.resolve(undefined);
        await eventually(() => (scene.counts.scans > scans ? true : undefined));
        await scene.stop();
        assert.equal(scene.counts.submissions, 0);
      } finally {
        admission.release.resolve(undefined);
        stopped.resolve(undefined);
        await updating;
        await scene.stop();
        admission.restore();
      }
    });
  });
});
