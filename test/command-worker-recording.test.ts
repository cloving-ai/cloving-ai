import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { until } from "./claude-worker-fixture.ts";
import {
  commandIntent,
  signal,
  withCommandScene,
} from "./command-worker-fixture.ts";

await test("CLV-352 command shutdown waits for a launch journal write before releasing its files", () =>
  withCommandScene(async (scene) => {
    const rename = filesystem.rename;
    const blocked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const recorded = Promise.withResolvers<undefined>();
    const order: string[] = [];
    mock.method(
      filesystem,
      "rename",
      async (
        source: Parameters<typeof rename>[0],
        target: Parameters<typeof rename>[1],
      ) => {
        const launch = String(target).endsWith("/launch.json");
        if (launch) {
          blocked.resolve(undefined);
          await release.promise;
        }
        await rename(source, target);
        if (launch) {
          order.push("recorded");
          recorded.resolve(undefined);
        }
      },
    );
    syncBuiltinESMExports();
    let closing: Promise<void> | undefined;
    try {
      const worker = scene.worker("setInterval(() => {}, 1000);");
      await worker.deliver(commandIntent(), signal);
      await blocked.promise;
      closing = worker.close().then(() => {
        order.push("closed");
      });
      await until(() => scene.reports.length === 1);
      await setImmediate();
      release.resolve(undefined);
      await Promise.all([closing, recorded.promise]);
      assert.deepEqual(order, ["recorded", "closed"]);
    } finally {
      release.resolve(undefined);
      await closing;
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  }));
