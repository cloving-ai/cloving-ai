import assert from "node:assert/strict";
import { chmod, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dependencySurface } from "../../quality/dependency-surface.ts";
import { withFiles } from "./files-fixture.ts";

const files = {
  "package.json": "{}",
  "package-lock.json": "{}",
  "dist/runtime.js": "export {};",
  "scripts/fixture.js": "#!/usr/bin/env node\n",
};

await test("QG-20 treats an aliased root consistently when installed binaries use file links", async () => {
  await withFiles(files, async (directory) => {
    await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
    await symlink(
      "../../scripts/fixture.js",
      join(directory, "node_modules/.bin/fixture"),
    );
    const alias = directory + "-alias";
    await symlink(directory, alias);
    try {
      const canonical = await dependencySurface(directory, ["dist/runtime.js"]);
      const aliased = await dependencySurface(alias, ["dist/runtime.js"]);
      assert.equal(aliased.digest, canonical.digest);
    } finally {
      await rm(alias);
    }
  });
});

await test("QG-20 binds the executable mode of a linked installed payload", async () => {
  await withFiles(files, async (directory) => {
    await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
    await symlink(
      "../../scripts/fixture.js",
      join(directory, "node_modules/.bin/fixture"),
    );
    const target = join(directory, "scripts/fixture.js");
    await chmod(target, 0o644);
    const before = await dependencySurface(directory, ["dist/runtime.js"]);
    await chmod(target, 0o755);
    const after = await dependencySurface(directory, ["dist/runtime.js"]);
    assert.notEqual(after.digest, before.digest);
  });
});
