import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { bundleSweep } from "../src/daemon/bundle-sweep.ts";
import type { RecordFiles } from "../src/daemon/record-archive.ts";
import { timesMarker, withBundles } from "./bundle-sweep-fixture.ts";

const archive = {
  retention: { days: 30, action: "archive", archiveFolder: null },
} as const;

const damages = {
  changed: (folder: string) =>
    writeFile(join(folder, "artifacts/flow.mjs"), "compiled FLOW"),
  partial: (folder: string) => rm(join(folder, "artifacts/steps.mjs")),
  larger: (folder: string) => writeFile(join(folder, "extra.json"), "{}"),
};

for (const [damage, damaged] of Object.entries(damages))
  await test(`CLV-295 an archive copy that differs (${damage}) keeps the bundle and logs the failure`, () =>
    withBundles(async (scene) => {
      const old = await scene.bundle("old", 40);
      await bundleSweep(scene.settings(archive)).pass();
      const archived = join(scene.root, "archive/workflow-bundles", old);
      await damaged(archived);
      assert.equal(await scene.bundle("old", 40), old);
      await bundleSweep(scene.settings(archive)).pass();
      const kept = join(scene.store, `.removing-${old}`);
      assert.equal(
        await readFile(join(kept, "artifacts/steps.mjs"), "utf8"),
        "compiled steps",
      );
      assert.equal(
        await readFile(join(kept, "artifacts/flow.mjs"), "utf8"),
        "compiled flow",
      );
      assert.deepEqual(scene.lines, [
        `retention: archived workflow bundle ${old}\n`,
        `retention: workflow bundle ${old} not removed (archive-copy-differs)\n`,
      ]);
    }));

await test("CLV-295 a pass removes at most five bundles, and the next pass removes the rest", () =>
  withBundles(async (scene) => {
    const digests: string[] = [];
    for (const name of ["a", "b", "c", "d", "e", "f", "g"])
      digests.push(await scene.bundle(name, 40));
    const sorted = digests.toSorted();
    const sweep = bundleSweep(scene.settings());
    await sweep.pass();
    assert.deepEqual(
      sorted.map((digest) => existsSync(join(scene.store, digest))),
      [false, false, false, false, false, true, true],
    );
    await sweep.pass();
    assert.deepEqual(
      scene.lines,
      sorted.map((digest) => `retention: deleted workflow bundle ${digest}\n`),
    );
  }));

await test("CLV-295 a pass goes on after the last bundle of the previous pass, so that failed removals do not stop the others", () =>
  withBundles(async (scene) => {
    const digests: string[] = [];
    for (const name of ["a", "b", "c", "d", "e", "f"])
      digests.push(await scene.bundle(name, 40));
    const sorted = digests.toSorted();
    const blocked = { now: true };
    const files: RecordFiles = {
      move: (source, target) =>
        blocked.now
          ? Promise.reject(new Error("disk-full"))
          : rename(source, target),
      copy: () => Promise.reject(new Error("disk-full")),
    };
    const sweep = bundleSweep(scene.settings({ ...archive, files }));
    await sweep.pass();
    await sweep.pass();
    blocked.now = false;
    await sweep.pass();
    await sweep.pass();
    assert.deepEqual(scene.lines, [
      ...sorted.map(
        (digest) =>
          `retention: workflow bundle ${digest} not removed (disk-full)\n`,
      ),
      ...sorted.map(
        (digest) => `retention: archived workflow bundle ${digest}\n`,
      ),
    ]);
  }));

await test("CLV-295 the first pass after an upgrade records all stored bundles as current, so that each keeps its full period", () =>
  withBundles(async (scene) => {
    await rm(join(scene.store, timesMarker));
    const old = await scene.bundle("old", 400);
    await bundleSweep(scene.settings()).pass();
    assert.equal(
      Math.round((await stat(join(scene.store, old))).mtimeMs),
      scene.now,
    );
    assert.equal(existsSync(join(scene.store, timesMarker)), true);
    await scene.aged(join(scene.store, old), 400);
    await bundleSweep(scene.settings()).pass();
    assert.equal(existsSync(join(scene.store, old)), false);
    assert.deepEqual(scene.lines, [
      `retention: deleted workflow bundle ${old}\n`,
    ]);
  }));
