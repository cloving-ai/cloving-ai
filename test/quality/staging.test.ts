import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stageCandidate } from "../../quality/staging.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-11 stages independent bytes and modes from candidate hardlinks", async () => {
  await withFiles(
    { "candidate/main.ts": "original", "candidate/.git/ignored": "state" },
    async (directory) => {
      const source = join(directory, "candidate");
      const destination = join(directory, "staged");
      const original = join(source, "main.ts");
      await chmod(original, 0o755);
      await link(original, join(source, "alias.ts"));
      const result = await stageCandidate(source, destination);
      assert.equal(result.directory, await realpath(destination));
      await assert.rejects(lstat(join(destination, ".git")), /ENOENT/);
      assert.match(result.identity, /^[a-f0-9]{64}$/);
      await writeFile(original, "changed");
      assert.equal(
        await readFile(join(destination, "main.ts"), "utf8"),
        "original",
      );
      assert.equal(
        await readFile(join(destination, "alias.ts"), "utf8"),
        "original",
      );
      assert.notEqual(
        (await lstat(original)).ino,
        (await lstat(join(destination, "main.ts"))).ino,
      );
      assert.equal(
        (await lstat(join(destination, "main.ts"))).mode & 0o777,
        0o755,
      );
    },
  );
});

await test("QG-11 stages internal npm links but rejects escaping links", async () => {
  await withFiles(
    { "candidate/node_modules/tool/bin.js": "tool", outside: "private" },
    async (directory) => {
      const source = join(directory, "candidate");
      await symlink("tool/bin.js", join(source, "node_modules/tool-link"));
      await stageCandidate(source, join(directory, "staged"));
      assert.equal(
        await readFile(
          join(directory, "staged/node_modules/tool-link"),
          "utf8",
        ),
        "tool",
      );
      await symlink("../outside", join(source, "escape"));
      await assert.rejects(
        stageCandidate(source, join(directory, "rejected")),
        /unsafe-staging-link/,
      );
    },
  );
});

await test("QG-10 rejects nested or existing staging destinations", async () => {
  await withFiles(
    { "candidate/main.ts": "original", "existing/keep": "keep" },
    async (directory) => {
      const source = join(directory, "candidate");
      await assert.rejects(
        stageCandidate(source, join(source, "nested")),
        /overlapping-staging-paths/,
      );
      await assert.rejects(
        stageCandidate(source, join(directory, "existing")),
        /EEXIST/,
      );
      assert.equal(
        await readFile(join(directory, "existing/keep"), "utf8"),
        "keep",
      );
    },
  );
});
