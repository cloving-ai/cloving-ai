import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withSweep } from "./record-sweep-fixture.ts";

await test("CLV-270 an archive pass moves due folders to the archive with the same relative path", () =>
  withSweep(async (scene) => {
    await scene.folder("journal/a", { runId: "done" });
    await scene.folder("github/b", { runId: "done" });
    await scene.folder("journal/c", { runId: "fresh" });
    await scene.folder("journal/d", { runId: "gate" });
    await scene.folder("github/e", "{");
    await scene.sweep().pass();
    for (const path of ["journal/a", "github/b"]) {
      assert.equal(existsSync(join(scene.root, path)), false);
      assert.equal(
        await readFile(
          join(scene.root, "archive", path, "result.json"),
          "utf8",
        ),
        "{}",
      );
    }
    for (const path of ["journal/c", "journal/d", "github/e"])
      assert.equal(existsSync(join(scene.root, path, "started.json")), true);
    assert.deepEqual(scene.lines, [
      "retention: archived 2, kept 1, skipped 1 (active runs), unreadable 1\n",
    ]);
  }));

await test("CLV-270 a delete pass removes due folders and moves nothing to the archive", () =>
  withSweep(async (scene) => {
    await scene.folder("journal/a", { runId: "done" });
    await scene
      .sweep({
        retention: { days: 30, action: "delete", archiveFolder: null },
      })
      .pass();
    assert.equal(existsSync(join(scene.root, "journal/a")), false);
    assert.equal(existsSync(join(scene.root, "archive")), false);
    assert.deepEqual(scene.lines, [
      "retention: deleted 1, kept 0, skipped 0 (active runs), unreadable 0\n",
    ]);
  }));

await test("CLV-270 a pass with no retention period moves no folder", () =>
  withSweep(async (scene) => {
    await scene.folder("journal/a", { runId: "done" });
    await scene
      .sweep({
        retention: { days: null, action: "delete", archiveFolder: null },
      })
      .pass();
    assert.equal(existsSync(join(scene.root, "journal/a/started.json")), true);
    assert.deepEqual(scene.lines, []);
    assert.deepEqual(scene.asked, []);
  }));

await test("CLV-270 a pass handles at most 200 folders and the next pass continues with the rest", () =>
  withSweep(async (scene) => {
    for (let index = 0; index < 205; index += 1)
      await scene.folder(`journal/k${String(index).padStart(3, "0")}`, {
        runId: "fresh",
      });
    await scene.folder("journal/z", { runId: "done" });
    const sweep = scene.sweep();
    await sweep.pass();
    assert.equal(existsSync(join(scene.root, "journal/z")), true);
    await sweep.pass();
    assert.equal(existsSync(join(scene.root, "archive/journal/z")), true);
    await sweep.pass();
    assert.deepEqual(scene.lines, [
      "retention: archived 0, kept 200, skipped 0 (active runs), unreadable 0\n",
      "retention: archived 1, kept 5, skipped 0 (active runs), unreadable 0\n",
      "retention: archived 0, kept 200, skipped 0 (active runs), unreadable 0\n",
    ]);
  }));

await test("CLV-270 a folder that cannot be read counts as unreadable and the pass handles the other folders", () =>
  withSweep(async (scene) => {
    await scene.folder("journal/a", { runId: "done" });
    const blocked = join(
      await scene.folder("journal/b", { runId: "done" }),
      "gh-config-x",
    );
    await mkdir(blocked);
    await chmod(blocked, 0);
    try {
      await scene.sweep().pass();
    } finally {
      await chmod(blocked, 0o700);
    }
    assert.equal(
      existsSync(join(scene.root, "archive/journal/a/result.json")),
      true,
    );
    assert.equal(existsSync(join(scene.root, "journal/b/started.json")), true);
    assert.deepEqual(scene.lines, [
      "retention: archived 1, kept 0, skipped 0 (active runs), unreadable 1\n",
    ]);
  }));

await test("CLV-270 a pass leaves the shared target records of the journal out of the sweep", () =>
  withSweep(async (scene) => {
    await scene.folder("journal/a", { runId: "done" });
    const targets = [
      "journal/targets/t.json",
      "journal/runs/r/targets/t.json",
    ].map((path) => join(scene.root, path));
    for (const target of targets) {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, "{}");
    }
    await scene.sweep().pass();
    for (const target of targets) assert.equal(existsSync(target), true);
    assert.deepEqual(scene.lines, [
      "retention: archived 1, kept 0, skipped 0 (active runs), unreadable 0\n",
    ]);
  }));

await test("CLV-305 a pass leaves the pull request claims of the GitHub journal out of the sweep", () =>
  withSweep(async (scene) => {
    await scene.folder("github/a", { runId: "done" });
    const claim = join(scene.root, "github/claims/t.json");
    await mkdir(join(claim, ".."), { recursive: true });
    await writeFile(claim, "{}");
    await scene.sweep().pass();
    assert.equal(existsSync(claim), true);
    assert.deepEqual(scene.lines, [
      "retention: archived 1, kept 0, skipped 0 (active runs), unreadable 0\n",
    ]);
  }));

await test("CLV-313 a pass leaves the answered review records of the GitHub journal out of the sweep", () =>
  withSweep(async (scene) => {
    await scene.folder("github/a", { runId: "done" });
    const answered = join(scene.root, "github/answered/pull-7.json");
    await mkdir(join(answered, ".."), { recursive: true });
    await writeFile(answered, "{}");
    await scene.sweep().pass();
    assert.equal(existsSync(answered), true);
    assert.deepEqual(scene.lines, [
      "retention: archived 1, kept 0, skipped 0 (active runs), unreadable 0\n",
    ]);
  }));

await test("CLV-300 a pass leaves the saved merge heads of the GitHub journal out of the sweep", () =>
  withSweep(async (scene) => {
    await scene.folder("github/a", { runId: "done" });
    const target = join(scene.root, "github/targets/t.json");
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "{}");
    await scene.sweep().pass();
    assert.equal(existsSync(target), true);
    assert.deepEqual(scene.lines, [
      "retention: archived 1, kept 0, skipped 0 (active runs), unreadable 0\n",
    ]);
  }));
