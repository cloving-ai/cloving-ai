import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
