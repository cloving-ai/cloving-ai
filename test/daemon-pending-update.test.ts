import assert from "node:assert/strict";
import filesystem, { readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import { record } from "../src/protocol.ts";
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

async function withClock(
  body: (clock: { now: number }) => Promise<void>,
): Promise<void> {
  const original = Date.now;
  const clock = { now: original() };
  Date.now = () => clock.now;
  try {
    await body(clock);
  } finally {
    Date.now = original;
  }
}

await test("CLV-141 the hold expires exactly 30 minutes after its start and reports each transition once", () =>
  withClock(async (clock) => {
    const timestamp = clock.now;
    await withPendingUpdate(
      timestamp - 50 * 60 * 1000,
      async ({ counts, lines, commands, stop }) => {
        await eventually(() => (counts.scans >= 3 ? true : undefined));
        assert.equal(counts.submissions, 0);
        assert.deepEqual(lines, ["Queue holding for pending self-update\n"]);
        clock.now = timestamp + 30 * 60 * 1000 - 1;
        const scans = counts.scans;
        await eventually(() => (counts.scans >= scans + 3 ? true : undefined));
        assert.equal(counts.submissions, 0);
        assert.deepEqual(lines, ["Queue holding for pending self-update\n"]);
        clock.now += 1;
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
      },
    );
  }));

await test("CLV-141 a 50 minute old mark starts a journaled hold at the first idle cycle", () =>
  withClock(async (clock) => {
    const startedAt = clock.now;
    const mark = startedAt - 50 * 60 * 1000;
    await withPendingUpdate(mark, async ({ counts, lines, commands, stop }) => {
      await eventually(() => (counts.scans >= 3 ? true : undefined));
      await stop();
      assert.equal(counts.submissions, 0);
      assert.deepEqual(lines, ["Queue holding for pending self-update\n"]);
      const saved: unknown = JSON.parse(await commands());
      assert.ok(
        saved && typeof saved === "object" && "selfUpdateHold" in saved,
      );
      assert.deepEqual(saved.selfUpdateHold, {
        mark: `${String(mark)}\n`,
        startedAt,
      });
    });
  }));

await test("CLV-141 a different mark value starts a fresh hold after the previous hold expired", () =>
  withClock(async (clock) => {
    const timestamp = clock.now;
    const mark = timestamp - 50 * 60 * 1000;
    await withPendingUpdate(mark, async (scene) => {
      await eventually(() => (scene.lines.length === 1 ? true : undefined));
      clock.now += 30 * 60 * 1000;
      await eventually(() =>
        scene.counts.submissions >= 3 ? true : undefined,
      );
      const heldAt = clock.now + 1;
      clock.now = heldAt;
      await writeFile(`${scene.mark}.tmp`, `${String(mark + 1)}\n`);
      await rename(`${scene.mark}.tmp`, scene.mark);
      await eventually(() => (scene.lines.length >= 3 ? true : undefined));
      await scene.stop();
      assert.deepEqual(scene.lines, [
        "Queue holding for pending self-update\n",
        "Queue continuing after pending self-update time limit\n",
        "Queue holding for pending self-update\n",
      ]);
      const saved: unknown = JSON.parse(await scene.commands());
      assert.deepEqual(record(saved)?.["selfUpdateHold"], {
        mark: `${String(mark + 1)}\n`,
        startedAt: heldAt,
      });
    });
  }));

await test("CLV-141 a queue restart preserves the hold start and its original deadline", () =>
  withClock(async (clock) => {
    const timestamp = clock.now;
    const mark = timestamp - 50 * 60 * 1000;
    await withPendingUpdate(mark, async (scene) => {
      await eventually(() => (scene.lines.length === 1 ? true : undefined));
      await scene.stop();
      clock.now += 20 * 60 * 1000;
      const queue = issueQueue({
        directory: scene.directory,
        runtimeDirectory: scene.runtimeDirectory,
        intervalMilliseconds: 5,
      });
      try {
        await eventually(() => (scene.lines.length === 2 ? true : undefined));
        assert.equal(scene.counts.submissions, 0);
        const saved: unknown = JSON.parse(await scene.commands());
        assert.deepEqual(record(saved)?.["selfUpdateHold"], {
          mark: `${String(mark)}\n`,
          startedAt: timestamp,
        });
        clock.now = timestamp + 30 * 60 * 1000;
        await eventually(() =>
          scene.counts.submissions >= 3 ? true : undefined,
        );
        await queue.stop();
        assert.deepEqual(scene.lines, [
          "Queue holding for pending self-update\n",
          "Queue holding for pending self-update\n",
          "Queue continuing after pending self-update time limit\n",
        ]);
      } finally {
        await queue.stop();
      }
    });
  }));

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
      const saved: unknown = JSON.parse(await scene.commands());
      assert.equal(record(saved)?.["selfUpdateHold"], undefined);
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
