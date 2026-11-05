import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  readRetainedWorkflowBundle,
  retainWorkflowBundle,
} from "../tools/workflow-bundles.ts";
import { bundleSweep, unfinishedPins } from "../src/daemon/bundle-sweep.ts";
import {
  reloadedTo,
  timesMarker,
  withBundles,
} from "./bundle-sweep-fixture.ts";

await test("CLV-295 the sweep deletes an old free bundle and keeps the pinned, current and recent bundles", () =>
  withBundles(async (scene) => {
    const old = await scene.bundle("old", 40);
    const pinned = await scene.bundle("pinned", 400);
    const current = await scene.bundle("current", 400);
    const recent = await scene.bundle("recent", 29);
    await bundleSweep(
      scene.settings({
        current: scene.current(current),
        pinned: () => Promise.resolve([pinned]),
      }),
    ).pass();
    assert.equal(existsSync(join(scene.store, old)), false);
    assert.equal(existsSync(join(scene.store, `.removing-${old}`)), false);
    for (const kept of [pinned, current, recent])
      assert.equal(
        (await readRetainedWorkflowBundle(scene.lookup(kept))).kind,
        "available",
      );
    assert.deepEqual(scene.lines, [
      `retention: deleted workflow bundle ${old}\n`,
    ]);
  }));

await test("CLV-295 the sweep records the current bundle as current, so that it stays after a later change", () =>
  withBundles(async (scene) => {
    const current = await scene.bundle("current", 400);
    await bundleSweep(
      scene.settings({ current: scene.current(current) }),
    ).pass();
    assert.equal(
      Math.round((await stat(join(scene.store, current))).mtimeMs),
      scene.now,
    );
    await bundleSweep(scene.settings()).pass();
    assert.equal(existsSync(join(scene.store, current)), true);
    assert.deepEqual(scene.lines, []);
  }));

await test("CLV-295 a later start can build a deleted bundle again from equal sources", () =>
  withBundles(async (scene) => {
    const old = await scene.bundle("old", 40);
    await bundleSweep(scene.settings()).pass();
    assert.equal(existsSync(join(scene.store, ".history", old)), false);
    assert.equal(await retainWorkflowBundle(scene.project("old")), old);
    assert.equal(
      (await readRetainedWorkflowBundle(scene.lookup(old))).kind,
      "available",
    );
  }));

await test("CLV-295 the archive action moves the bundle to the archive folder, also when the archive has it already", () =>
  withBundles(async (scene) => {
    const archive = {
      days: 30,
      action: "archive",
      archiveFolder: null,
    } as const;
    const old = await scene.bundle("old", 40);
    await bundleSweep(scene.settings({ retention: archive })).pass();
    const archived = join(scene.root, "archive/workflow-bundles", old);
    assert.equal(existsSync(join(archived, "bundle.json")), true);
    assert.equal(existsSync(join(scene.store, old)), false);
    assert.equal(await scene.bundle("old", 40), old);
    await bundleSweep(scene.settings({ retention: archive })).pass();
    assert.equal(existsSync(join(scene.store, old)), false);
    assert.equal(existsSync(join(scene.store, `.removing-${old}`)), false);
    assert.equal(existsSync(join(archived, "bundle.json")), true);
    assert.deepEqual(scene.lines, [
      `retention: archived workflow bundle ${old}\n`,
      `retention: archived workflow bundle ${old}\n`,
    ]);
  }));

await test("CLV-295 retention days null keeps all bundles", () =>
  withBundles(async (scene) => {
    const old = await scene.bundle("old", 400);
    await bundleSweep(
      scene.settings({
        retention: { days: null, action: "delete", archiveFolder: null },
      }),
    ).pass();
    assert.equal(existsSync(join(scene.store, old)), true);
    assert.deepEqual(scene.lines, []);
  }));

await test("CLV-295 lookup ignores a renamed bundle folder, and the next sweep removes it", () =>
  withBundles(async (scene) => {
    const old = await scene.bundle("old", 1);
    const renamed = join(scene.store, `.removing-${old}`);
    await rename(join(scene.store, old), renamed);
    for (const id of [old, `.removing-${old}`])
      assert.equal(
        (await readRetainedWorkflowBundle(scene.lookup(id))).kind,
        "unavailable",
      );
    await bundleSweep(scene.settings()).pass();
    assert.equal(existsSync(renamed), false);
    assert.deepEqual(scene.lines, [
      `retention: deleted workflow bundle ${old}\n`,
    ]);
  }));

await test("CLV-295 the sweep leaves other entries of the bundle folder in place", () =>
  withBundles(async (scene) => {
    const recent = await scene.bundle("recent", 1);
    const others = [".pending-a", ".removing-short", "a".repeat(63)];
    for (const name of others) {
      await mkdir(join(scene.store, name));
      await scene.aged(join(scene.store, name), 400);
    }
    await symlink(scene.root, join(scene.store, "b".repeat(64)));
    await bundleSweep(scene.settings()).pass();
    assert.deepEqual(
      (await readdir(scene.store)).sort(),
      [...others, ".history", timesMarker, "b".repeat(64), recent].sort(),
    );
    assert.equal(scene.lines.length, 0);
  }));

await test("CLV-295 an archive folder that is not available moves no bundle", () =>
  withBundles(async (scene) => {
    const old = await scene.bundle("old", 40);
    await bundleSweep(
      scene.settings({
        retention: {
          days: 30,
          action: "archive",
          archiveFolder: join(scene.root, "absent"),
        },
      }),
    ).pass();
    assert.equal(existsSync(join(scene.store, old)), true);
    assert.deepEqual(scene.lines, []);
  }));

await test("CLV-295 a pass that fails logs the reason and removes nothing", () =>
  withBundles(async (scene) => {
    const old = await scene.bundle("old", 40);
    await bundleSweep(
      scene.settings({
        pinned: () => Promise.reject(new Error("authority-closed")),
      }),
    ).pass();
    assert.equal(existsSync(join(scene.store, old)), true);
    assert.deepEqual(scene.lines, [
      "retention: workflow bundles failed (authority-closed)\n",
    ]);
  }));

await test("CLV-295 a removal that fails logs the digest and the reason", () =>
  withBundles(async (scene) => {
    const old = await scene.bundle("old", 40);
    await bundleSweep(
      scene.settings({
        retention: { days: 30, action: "archive", archiveFolder: null },
        files: {
          move: () => Promise.reject(new Error("disk-full")),
          copy: () => Promise.reject(new Error("disk-full")),
        },
      }),
    ).pass();
    assert.equal(existsSync(join(scene.store, `.removing-${old}`)), true);
    assert.deepEqual(scene.lines, [
      `retention: workflow bundle ${old} not removed (disk-full)\n`,
    ]);
  }));

await test("CLV-295 a missing bundle folder gives an empty pass", () =>
  withBundles(async (scene) => {
    await bundleSweep(
      scene.settings({ directory: join(scene.root, "absent") }),
    ).pass();
    assert.deepEqual(scene.lines, []);
  }));

await test("CLV-295 a reload records the old and the new bundle as current at the switch", () =>
  withBundles(async (scene) => {
    const first = await scene.bundle("first", 400);
    const next = await scene.bundle("next", 400);
    const current = scene.current(first);
    const refused = await current.reloading(() =>
      Promise.resolve({ kind: "refused", code: "reload-failed", detail: "x" }),
    )();
    assert.equal(refused.kind, "refused");
    assert.equal(current.digest(), first);
    const outcome = await current.reloading(() =>
      Promise.resolve(reloadedTo(next)),
    )();
    assert.equal(outcome.kind, "reloaded");
    assert.equal(current.digest(), next);
    for (const digest of [first, next])
      assert.equal(
        Math.round((await stat(join(scene.store, digest))).mtimeMs),
        scene.now,
      );
  }));

await test("CLV-295 a pass waits for a reload, so that a bundle that the reload makes current stays", () =>
  withBundles(async (scene) => {
    const first = await scene.bundle("first", 1);
    const old = await scene.bundle("old", 400);
    const current = scene.current(first);
    const gate = Promise.withResolvers<undefined>();
    const reload = current.reloading(async () => {
      await gate.promise;
      return reloadedTo(old);
    })();
    const pass = bundleSweep(scene.settings({ current })).pass();
    const raced = await Promise.race([
      pass.then(() => "passed"),
      delay(200).then(() => "waiting"),
    ]);
    gate.resolve(undefined);
    await reload;
    await pass;
    assert.equal(raced, "waiting");
    assert.equal(current.digest(), old);
    for (const digest of [first, old])
      assert.equal(existsSync(join(scene.store, digest)), true);
    assert.deepEqual(scene.lines, []);
  }));

await test("CLV-295 the pinned bundles are the bundle digests of the unfinished runs", async () => {
  const runs = {
    done: { runId: "done", status: "completed" },
    waiting: { runId: "waiting", status: "waiting_gate" },
    unbundled: { runId: "unbundled", status: "running" },
    unknown: { runId: "unknown", status: "queued" },
  };
  const manifests = new Map([
    ["done", { bundleDigest: "a".repeat(64) }],
    ["waiting", { bundleDigest: "b".repeat(64) }],
    ["unbundled", {}],
  ]);
  const pinned = unfinishedPins({
    state: () => Promise.resolve({ runs }),
    manifest: (runId) => Promise.resolve(manifests.get(runId)),
  });
  assert.deepEqual(await pinned(), ["b".repeat(64)]);
});

await test("CLV-295 a stamp that fails logs the digest, keeps the reload outcome and stops the pass", () =>
  withBundles(async (scene) => {
    await rm(scene.store, { recursive: true });
    await writeFile(scene.store, "");
    const [first, next] = ["a".repeat(64), "b".repeat(64)];
    const current = scene.current(first);
    const outcome = await current.reloading(() =>
      Promise.resolve(reloadedTo(next)),
    )();
    assert.equal(outcome.kind, "reloaded");
    assert.equal(current.digest(), next);
    await bundleSweep(scene.settings({ current })).pass();
    assert.deepEqual(scene.lines, [
      `retention: workflow bundle ${first} not marked current (ENOTDIR)\n`,
      `retention: workflow bundle ${next} not marked current (ENOTDIR)\n`,
      "retention: workflow bundles failed (ENOTDIR)\n",
    ]);
  }));
