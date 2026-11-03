import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { nodeFiles } from "../src/daemon/record-archive.ts";
import { withSweep } from "./record-sweep-fixture.ts";

function otherVolume(): Error {
  return Object.assign(new Error("cross-device link not permitted"), {
    code: "EXDEV",
  });
}

await test("CLV-270 a configured archive folder takes the journal and GitHub folders", () =>
  withSweep(async (scene) => {
    const archiveFolder = join(scene.root, "volume");
    await mkdir(archiveFolder);
    await scene.folder("journal/a", { runId: "done" });
    await scene.folder("github/b", { runId: "done" });
    await scene
      .sweep({
        retention: { days: 30, action: "archive", archiveFolder },
      })
      .pass();
    assert.deepEqual(await readdir(join(archiveFolder, "journal")), ["a"]);
    assert.deepEqual(await readdir(join(archiveFolder, "github")), ["b"]);
    assert.equal(existsSync(join(scene.root, "archive")), false);
  }));

await test("CLV-270 an archive folder that is not available moves nothing and the next pass tries again", () =>
  withSweep(async (scene) => {
    const archiveFolder = join(scene.root, "unmounted");
    await scene.folder("journal/a", { runId: "done" });
    const sweep = scene.sweep({
      retention: { days: 30, action: "archive", archiveFolder },
    });
    await sweep.pass();
    assert.equal(existsSync(join(scene.root, "journal/a/started.json")), true);
    assert.equal(existsSync(archiveFolder), false);
    await mkdir(archiveFolder);
    await sweep.pass();
    assert.equal(
      existsSync(join(archiveFolder, "journal/a/started.json")),
      true,
    );
    assert.deepEqual(scene.lines, [
      "retention: archive folder not available (ENOENT), moved nothing\n",
      "retention: archived 1, kept 0, skipped 0 (active runs), unreadable 0\n",
    ]);
  }));

await test("CLV-270 an archive on another volume keeps the source until the copy is complete", () =>
  withSweep(async (scene) => {
    const source = await scene.folder("journal/a", { runId: "done" });
    const seen: boolean[] = [];
    await scene
      .sweep({
        files: {
          move: () => Promise.reject(otherVolume()),
          copy: async (from, to) => {
            await cp(from, to, { recursive: true });
            seen.push(existsSync(join(source, "result.json")));
          },
        },
      })
      .pass();
    assert.deepEqual(seen, [true]);
    assert.equal(existsSync(source), false);
    assert.equal(
      await readFile(join(scene.root, "archive/journal/a/result.json"), "utf8"),
      "{}",
    );
    assert.deepEqual(await readdir(join(scene.root, "archive/journal")), ["a"]);
  }));

for (const [name, copy, reason] of [
  [
    "an incomplete copy",
    (from: string, to: string) =>
      cp(join(from, "started.json"), join(to, "started.json")),
    "archive-copy-incomplete",
  ],
  [
    "a copy that fails",
    () => Promise.reject(new Error("disk-full")),
    "disk-full",
  ],
  [
    "a copy that fails with an error code",
    () =>
      Promise.reject(
        Object.assign(new Error("no space left"), { code: "ENOSPC" }),
      ),
    "ENOSPC",
  ],
] as const)
  await test(`CLV-270 ${name} on another volume keeps the source and logs the reason`, () =>
    withSweep(async (scene) => {
      const source = await scene.folder("journal/a", { runId: "done" });
      await scene
        .sweep({
          files: { move: () => Promise.reject(otherVolume()), copy },
        })
        .pass();
      assert.deepEqual((await readdir(source)).sort(), [
        "result.json",
        "started.json",
      ]);
      assert.deepEqual(await readdir(join(scene.root, "archive/journal")), []);
      assert.deepEqual(scene.lines, [
        `retention: archived 0, kept 0, skipped 0 (active runs), unreadable 0, failed 1 (journal/a: ${reason})\n`,
      ]);
    }));

await test("CLV-270 the default copy to another volume keeps the nested files and their times", () =>
  withSweep(async (scene) => {
    const source = await scene.folder("journal/a", { runId: "done" });
    await mkdir(join(source, "attempt-2"));
    await writeFile(join(source, "attempt-2/turn.jsonl"), "{}\n");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(join(source, "attempt-2/turn.jsonl"), old, old);
    await scene
      .sweep({
        files: { ...nodeFiles, move: () => Promise.reject(otherVolume()) },
      })
      .pass();
    const copied = join(scene.root, "archive/journal/a/attempt-2/turn.jsonl");
    assert.equal(await readFile(copied, "utf8"), "{}\n");
    assert.equal((await stat(copied)).mtimeMs, old.getTime());
    assert.equal(existsSync(source), false);
  }));

await test("CLV-270 an archive path that is a file moves nothing", () =>
  withSweep(async (scene) => {
    const archiveFolder = join(scene.root, "archive-file");
    await writeFile(archiveFolder, "");
    await scene.folder("journal/a", { runId: "done" });
    await scene
      .sweep({
        retention: { days: 30, action: "archive", archiveFolder },
      })
      .pass();
    assert.equal(existsSync(join(scene.root, "journal/a/started.json")), true);
    assert.deepEqual(scene.lines, [
      "retention: archive folder not available (not-a-folder), moved nothing\n",
    ]);
  }));

await test("CLV-270 a move that fails on the same volume keeps the source and logs the reason", () =>
  withSweep(async (scene) => {
    const source = await scene.folder("journal/a", { runId: "done" });
    await mkdir(join(scene.root, "archive/journal/a"), { recursive: true });
    await writeFile(join(scene.root, "archive/journal/a/other.json"), "{}");
    await scene.sweep().pass();
    assert.equal(existsSync(join(source, "started.json")), true);
    assert.match(
      scene.lines.join(""),
      /^retention: archived 0, kept 0, skipped 0 \(active runs\), unreadable 0, failed 1 \(journal\/a: E[A-Z]+\)\n$/,
    );
  }));
