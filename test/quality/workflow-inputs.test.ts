import assert from "node:assert/strict";
import { join } from "node:path";
import { realpath, symlink } from "node:fs/promises";
import { test } from "node:test";
import { inspectWorkflowInputs } from "../../quality/workflow-inputs.ts";
import { withFiles } from "./files-fixture.ts";

const source = "export async function run() { 'use workflow'; return 1; }";

for (const fixture of [
  {
    files: {
      "consumer/main.ts":
        'const value = require("../outside.cjs"); export { value };',
      "outside.cjs": "module.exports = 1;",
    },
    diagnostic: /unsupported-loading/,
    name: "CommonJS input outside the SDK source inventory",
  },
  {
    files: {
      "consumer/main.ts":
        'import { value } from "./value.js"; export { value };',
      "consumer/value.d.ts": "export declare const value: number;",
      "consumer/value.js": 'export { value } from "../outside.mjs";',
      "outside.mjs": "export const value = 1;",
    },
    diagnostic: /unqualified-runtime-target/,
    name: "declaration resolution that hides an SDK runtime input",
  },
]) {
  await test(`QG-07 rejects ${fixture.name}`, async () => {
    await withFiles(fixture.files, async (directory) => {
      const root = join(directory, "consumer");
      await assert.rejects(
        inspectWorkflowInputs(root, [join(root, "main.ts")], []),
        fixture.diagnostic,
      );
    });
  });
}

await test("QG-07 records local SDK source and fixed configuration inputs", async () => {
  await withFiles(
    { "consumer/main.ts": source, "consumer/tsconfig.json": "{}" },
    async (directory) => {
      const root = await realpath(join(directory, "consumer"));
      const record = await inspectWorkflowInputs(
        root,
        [join(root, "main.ts")],
        [],
      );
      assert.match(record[join(root, "main.ts")] ?? "", /^[a-f0-9]{64}$/);
      assert.match(record[join(root, "tsconfig.json")] ?? "", /^[a-f0-9]{64}$/);
      assert.equal(
        record[join(await realpath(directory), "tsconfig.json")],
        null,
      );
    },
  );
});

for (const name of ["tsconfig.json", "jsconfig.json"]) {
  await test(`QG-07 rejects ancestor ${name} before SDK execution`, async () => {
    await withFiles(
      { [name]: "{}", "consumer/main.ts": source },
      async (directory) => {
        await assert.rejects(
          inspectWorkflowInputs(
            join(directory, "consumer"),
            [join(directory, "consumer/main.ts")],
            [],
          ),
          /unadmitted-ancestor-configuration/,
        );
      },
    );
  });
}

for (const configuration of [
  { extends: "../config.json" },
  { compilerOptions: { paths: { value: ["../outside.ts"] } } },
]) {
  await test(`QG-07 rejects unqualified SDK resolution: ${JSON.stringify(configuration)}`, async () => {
    await withFiles(
      {
        "consumer/tsconfig.json": JSON.stringify(configuration),
        "consumer/main.ts": source,
      },
      async (directory) => {
        await assert.rejects(
          inspectWorkflowInputs(
            join(directory, "consumer"),
            [join(directory, "consumer/main.ts")],
            [],
          ),
          /unqualified-workflow-configuration/,
        );
      },
    );
  });
}

await test("QG-07 rejects SDK imports and source links outside admitted roots", async () => {
  await withFiles(
    {
      "outside.ts": "export const value = 1;",
      "consumer/main.ts":
        'import { value } from "../outside.ts"; export { value };',
    },
    async (directory) => {
      const root = join(directory, "consumer");
      await assert.rejects(
        inspectWorkflowInputs(root, [join(root, "main.ts")], []),
        /outside-workflow-input/,
      );
      await symlink(join(directory, "outside.ts"), join(root, "link.ts"));
      await assert.rejects(
        inspectWorkflowInputs(root, [join(root, "link.ts")], []),
        /outside-workflow-input/,
      );
    },
  );
});
