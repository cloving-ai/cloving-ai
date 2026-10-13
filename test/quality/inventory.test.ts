import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectInventory } from "../../quality/inventory.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-07 discovers nested packages, ignored-looking directories and generated headers", async () => {
  const files = {
    "src/main.ts": "export {};",
    "packages/hidden/package.json": "{}",
    "packages/hidden/dist/logic.js": "/* generated */ export {};",
    "packages/hidden/node_modules/copied.mjs": "export {};",
    "node_modules/external/index.js": "0;",
    ".git/ignored.js": "0;",
  };
  await withFiles(files, async (directory) => {
    const inventory = await inspectInventory(directory, {});
    assert.deepEqual(inventory.sources, [
      "packages/hidden/dist/logic.js",
      "packages/hidden/node_modules/copied.mjs",
      "src/main.ts",
    ]);
    assert.deepEqual(inventory.metadata, ["packages/hidden/package.json"]);
  });
});

await test("QG-07 admits only exact recorded generated outputs and retains extra source", async () => {
  const output = "export const generated = 1;";
  const digest = createHash("sha256").update(output).digest("hex");
  await withFiles(
    {
      "src/main.ts": "export {};",
      "dist/generated.js": output,
      "dist/hidden.ts": "export {};",
    },
    async (directory) => {
      const inventory = await inspectInventory(directory, {
        "dist/generated.js": digest,
      });
      assert.deepEqual(inventory.generated, ["dist/generated.js"]);
      assert.deepEqual(inventory.sources, ["dist/hidden.ts", "src/main.ts"]);
      await assert.rejects(
        inspectInventory(directory, { "dist/generated.js": "wrong" }),
        /generated-digest-mismatch/,
      );
      await assert.rejects(
        inspectInventory(directory, { "dist/missing.js": digest }),
        /missing-generated-output/,
      );
    },
  );
});

await test("QG-07 rejects unexamined extensions, empty sources and symlinks", async () => {
  await withFiles({ "README.md": "metadata only" }, async (directory) => {
    await assert.rejects(
      inspectInventory(directory, {}),
      /empty-source-inventory/,
    );
  });
  await withFiles({ "main.py": "print(1)" }, async (directory) => {
    await assert.rejects(
      inspectInventory(directory, {}),
      /unsupported-inventory-file/,
    );
  });
  await withFiles({ "main.ts": "export {};" }, async (directory) => {
    await symlink(join(directory, "main.ts"), join(directory, "alias.ts"));
    await assert.rejects(inspectInventory(directory, {}), /inventory-symlink/);
  });
});

await test("QG-07 reads a git work tree, whose root has a git file in place of the git directory, and it still rejects a git file in a nested directory", async () => {
  await withFiles(
    { "src/main.ts": "export {};", ".git": "gitdir: /repository/.git\n" },
    async (directory) => {
      const inventory = await inspectInventory(directory, {});
      assert.deepEqual(inventory.sources, ["src/main.ts"]);
      assert.deepEqual(inventory.metadata, []);
    },
  );
  await withFiles(
    { "src/main.ts": "export {};", "src/.git": "gitdir: /repository/.git\n" },
    async (directory) => {
      await assert.rejects(
        inspectInventory(directory, {}),
        /unsupported-inventory-file: src\/\.git/,
      );
    },
  );
});
