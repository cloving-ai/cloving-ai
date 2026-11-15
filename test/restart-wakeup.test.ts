import assert from "node:assert/strict";
import filesystem, { type StatWatcher } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import { restartWakeup } from "../tools/restart-wakeup.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-347 restart polling survives an unavailable filesystem watcher and stops on cancellation", () =>
  withFiles({}, async (directory) => {
    const stopping = new AbortController();
    mock.method(filesystem, "watchFile", () => {
      throw Object.assign(new Error("no watches available"), {
        code: "ENOSPC",
      });
    });
    syncBuiltinESMExports();
    const waking = restartWakeup({
      directory,
      milliseconds: 1,
      stopping: stopping.signal,
    });
    try {
      assert.equal(await waking.wait(), true);
      stopping.abort();
      assert.equal(await waking.wait(), false);
    } finally {
      waking.close();
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  }));

await test("CLV-347 restart wakeups coalesce directory changes and release their watcher on close", () =>
  withFiles({}, async (directory) => {
    const stopping = new AbortController();
    const original = filesystem.watchFile;
    let watcher: StatWatcher | undefined;
    mock.method(
      filesystem,
      "watchFile",
      (...argumentsList: Parameters<typeof original>) => {
        watcher = original(...argumentsList);
        return watcher;
      },
    );
    syncBuiltinESMExports();
    const waking = restartWakeup({
      directory,
      milliseconds: 1,
      stopping: stopping.signal,
    });
    try {
      assert.ok(watcher);
      watcher.emit("change");
      watcher.emit("change");
      assert.equal(await waking.wait(), true);
      watcher.emit("change");
      assert.equal(await waking.wait(), true);
      assert.equal(await waking.wait(), true);
      waking.close();
      assert.equal(await waking.wait(), false);
    } finally {
      stopping.abort();
      waking.close();
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  }));
