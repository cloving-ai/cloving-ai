import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { stalledCheck } from "./self-host-processes-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

for (const signal of ["SIGINT", "SIGTERM"]) {
  await test(`CLV-085 ${signal} awaits a local merge before shutdown completes`, async () => {
    await withUpdateRepository(async ({ root, repository, git, target }) => {
      const result = await stalledCheck(root, {
        repository,
        command: "merge",
        signal,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 75, result.stderr);
      assert.equal(git(["rev-parse", "HEAD"]), target);
      assert.equal(
        await readFile(join(root, "merge-completed"), "utf8"),
        "completed",
      );
      await assert.rejects(readFile(join(root, "host/failed-self-updates")), {
        code: "ENOENT",
      });
    });
  });
}

await test("CLV-196 the merge fixture completes without directory notifications", async () => {
  await withUpdateRepository(async ({ root, repository, git, target }) => {
    const preload = join(root, "quiet-watch.mjs");
    await writeFile(
      preload,
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const watch = fs.watch; fs.watch = path => watch(path, () => {}); syncBuiltinESMExports();',
    );
    const previous = process.env["NODE_OPTIONS"];
    process.env["NODE_OPTIONS"] =
      `${previous ?? ""} --import=${pathToFileURL(preload).href}`;
    try {
      const result = await stalledCheck(root, {
        repository,
        command: "merge",
        signal: "SIGTERM",
      });
      assert.equal(
        await readFile(join(root, "shutdown-observed"), "utf8"),
        "observed",
      );
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 75, result.stderr);
      assert.equal(git(["rev-parse", "HEAD"]), target);
      assert.equal(
        await readFile(join(root, "merge-completed"), "utf8"),
        "completed",
      );
    } finally {
      if (previous === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = previous;
    }
  });
});
