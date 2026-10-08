import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { sourceFiles } from "../../quality/source-files.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-01 discovers all admitted source extensions including nested tests and tools", async () => {
  const files = Object.fromEntries(
    ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"].map((extension) => [
      `test/nested/example.${extension}`,
      "export {};",
    ]),
  );
  files["tools/helper.ts"] = "export {};";
  await withFiles(files, async (directory) => {
    assert.deepEqual(
      (await sourceFiles(directory)).map((path) => relative(directory, path)),
      Object.keys(files).sort(),
    );
  });
});

await test("QG-10 rejects an empty executable source inventory", async () => {
  await withFiles({ "README.md": "Example" }, async (directory) => {
    await assert.rejects(sourceFiles(directory), /empty-source-inventory/);
  });
});

await test("QG-07 includes unadmitted build output and nested dependency folders", async () => {
  await withFiles(
    {
      "src/main.ts": "export {};",
      "node_modules/tool/index.js": "0;",
      "dist/main.js": "0;",
      "nested/node_modules/copied.ts": "export {};",
      ".git/hook.js": "0;",
    },
    async (directory) => {
      assert.deepEqual(await sourceFiles(directory), [
        join(directory, "dist/main.js"),
        join(directory, "nested/node_modules/copied.ts"),
        join(directory, "src/main.ts"),
      ]);
    },
  );
});

await test("QG-10 rejects unsupported files and source symlinks", async () => {
  await withFiles({ "main.py": "print(1)" }, async (directory) => {
    await assert.rejects(sourceFiles(directory), /unsupported-inventory-file/);
  });
  await withFiles({ "main.ts": "export {};" }, async (directory) => {
    await symlink(join(directory, "main.ts"), join(directory, "linked.ts"));
    await assert.rejects(sourceFiles(directory), /inventory-symlink/);
  });
});

await test("QG-07 excludes only an exact admitted generated output", async () => {
  const output = "export {};";
  const digest = createHash("sha256").update(output).digest("hex");
  await withFiles(
    { "main.ts": "export {};", "dist/main.js": output },
    async (directory) => {
      const options = { generated: { "dist/main.js": digest } };
      assert.deepEqual(await sourceFiles(directory, options), [
        join(directory, "main.ts"),
      ]);
      await assert.rejects(
        sourceFiles(directory, { generated: { "dist/main.js": "invalid" } }),
        /generated-digest-mismatch/,
      );
    },
  );
});
