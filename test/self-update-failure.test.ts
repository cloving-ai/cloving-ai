import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { selfUpdater } from "../tools/self-update.ts";
import {
  mergeCommand,
  statusCommand,
  withUpdate,
} from "./self-update-fixture.ts";

await test("CLV-085 a failed fast-forward records the target and skips it after restart", async () => {
  await withUpdate(async (fixture) => {
    fixture.failures.set(
      mergeCommand,
      new Error("fast-forward refused\nlocal conflict"),
    );
    assert.equal(await fixture.updater.check(), 75);
    assert.equal(fixture.errors.length, 1);
    assert.match(String(fixture.errors[0]), /fast-forward refused/);
    assert.equal(String(fixture.errors[0]).trim().split("\n").length, 1);
    assert.equal(
      await readFile(join(fixture.directory, "failed-self-updates"), "utf8"),
      "target\n",
    );
    fixture.failures.clear();
    fixture.actions.length = 0;
    assert.equal(await selfUpdater(fixture.settings).check(), undefined);
    assert.equal(fixture.actions.includes("stop"), false);
    assert.equal(fixture.actions.includes(mergeCommand), false);
  });
});

for (const changed of [
  "dirty",
  "index",
  "status-error",
  "branch",
  "head",
  "detached",
  "head-error",
] as const) {
  await test(`CLV-085 ${changed} after stop records failure and restarts without merge`, async () => {
    await withUpdate(async (fixture) => {
      const updater = selfUpdater({
        ...fixture.settings,
        stop: async () => {
          await fixture.settings.stop();
          if (changed === "dirty")
            fixture.replies[statusCommand] = "?? arrived.txt\n";
          if (changed === "index")
            fixture.replies["ls-files -v"] = "h hidden.txt\n";
          if (changed === "status-error")
            fixture.failures.set(
              statusCommand,
              new Error("status unavailable"),
            );
          if (changed === "branch")
            fixture.replies["symbolic-ref HEAD"] = "refs/heads/work\n";
          if (changed === "head") fixture.replies["rev-parse HEAD"] = "moved\n";
          if (changed === "detached")
            fixture.failures.set("symbolic-ref HEAD", new Error("detached"));
          if (changed === "head-error")
            fixture.failures.set(
              "rev-parse HEAD",
              new Error("HEAD unavailable"),
            );
        },
      });
      assert.equal(await updater.check(), 75);
      assert.equal(fixture.actions.includes(mergeCommand), false);
      assert.equal(fixture.errors.length, 1);
      assert.equal(
        await readFile(join(fixture.directory, "failed-self-updates"), "utf8"),
        "target\n",
      );
      fixture.failures.clear();
      fixture.replies["symbolic-ref HEAD"] = "refs/heads/main\n";
      fixture.replies["rev-parse HEAD"] = "old\n";
      fixture.actions.length = 0;
      assert.equal(await selfUpdater(fixture.settings).check(), undefined);
      assert.equal(fixture.actions.includes("stop"), false);
      assert.equal(fixture.actions.includes(mergeCommand), false);
    });
  });
}

await test("CLV-085 overlapping checks do no work", async () => {
  await withUpdate(async (fixture) => {
    const fetched = Promise.withResolvers<undefined>();
    const released = Promise.withResolvers<undefined>();
    let fetches = 0;
    const updater = selfUpdater({
      ...fixture.settings,
      git: async (argumentsList) => {
        if (argumentsList[0] === "fetch" && ++fetches === 1) {
          fetched.resolve(undefined);
          await released.promise;
        }
        return fixture.settings.git(argumentsList);
      },
    });
    const running = updater.check();
    await fetched.promise;
    try {
      assert.equal(await updater.check(), undefined);
      assert.equal(fetches, 1);
      assert.equal(fixture.actions.includes(mergeCommand), false);
    } finally {
      released.resolve(undefined);
      await running;
    }
  });
});

await test("CLV-085 an update waits for shutdown before rechecking and merging", async () => {
  await withUpdate(async (fixture) => {
    const requested = Promise.withResolvers<undefined>();
    const stopped = Promise.withResolvers<undefined>();
    const updater = selfUpdater({
      ...fixture.settings,
      stop: () => {
        requested.resolve(undefined);
        return stopped.promise;
      },
    });
    const running = updater.check();
    await requested.promise;
    try {
      assert.equal(
        fixture.actions.filter((action) => action === statusCommand).length,
        1,
      );
      assert.equal(fixture.actions.includes(mergeCommand), false);
    } finally {
      stopped.resolve(undefined);
      await running;
    }
    assert.equal(await running, 75);
    assert.equal(fixture.actions.includes(mergeCommand), true);
  });
});
