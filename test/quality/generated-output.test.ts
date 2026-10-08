import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inspectGenerated } from "../../quality/generated-output.ts";
import { sourceFiles } from "../../quality/source-files.ts";
import { withFiles } from "./files-fixture.ts";

const source = "export const value = 1;\n";
const javascript = "export const value = 1;\n";
const declaration = "export declare const value = 1;\n";
const configuration = JSON.stringify({
  compilerOptions: {
    target: "ES2024",
    module: "NodeNext",
    rootDir: ".",
    outDir: "dist",
    types: [],
    declaration: true,
  },
  include: ["src/**/*.ts"],
});
const files = {
  "package.json": '{"type":"module"}',
  "tsconfig.json": configuration,
  "tsconfig.build.json": '{"extends":"./tsconfig.json"}',
  "src/main.ts": source,
  "dist/src/main.js": javascript,
  "dist/src/main.d.ts": declaration,
};

await test("QG-07 regenerates exact TypeScript output and binds source/configuration inputs", async () => {
  await withFiles(files, async (directory) => {
    const record = await inspectGenerated(directory);
    assert.deepEqual(Object.keys(record.outputs).sort(), [
      "dist/src/main.d.ts",
      "dist/src/main.js",
    ]);
    assert.equal(
      record.inputs["src/main.ts"],
      createHash("sha256").update(source).digest("hex"),
    );
    assert.ok(record.inputs["tsconfig.build.json"]);
    assert.ok(record.inputs["tsconfig.json"]);
    assert.match(record.generator, /typescript@6\.0\.3/);
    assert.equal(
      (await sourceFiles(directory, { generated: record.outputs })).length,
      1,
    );
  });
});

await test("QG-07 rejects changed, missing and invalid generated artifacts", async () => {
  await withFiles(
    { ...files, "dist/src/main.js": "export const value = 2;\n" },
    async (directory) => {
      await assert.rejects(
        inspectGenerated(directory),
        /generated-output-mismatch/,
      );
    },
  );
  await withFiles(
    { ...files, "src/main.ts": "export const value: string = 1;\n" },
    async (directory) => {
      await assert.rejects(
        inspectGenerated(directory),
        /generator-compiler-diagnostics/,
      );
    },
  );
  const missing = { ...files };
  Reflect.deleteProperty(missing, "dist/src/main.d.ts");
  await withFiles(missing, async (directory) => {
    await assert.rejects(
      inspectGenerated(directory),
      /missing-generated-output/,
    );
  });
});

await test("QG-07 generated output cannot exempt additional handwritten files", async () => {
  await withFiles(
    { ...files, "dist/hidden.ts": "/* generated */ export {};" },
    async (directory) => {
      const record = await inspectGenerated(directory);
      const sources = await sourceFiles(directory, {
        generated: record.outputs,
      });
      assert.equal(sources.length, 2);
      assert.ok(sources.some((file) => file.endsWith("dist/hidden.ts")));
    },
  );
});

await test("QG-07 binds nested package metadata read by module resolution", async () => {
  const metadata = '{"type":"module"}';
  await withFiles(
    { ...files, "src/package.json": metadata },
    async (directory) => {
      const record = await inspectGenerated(directory);
      assert.equal(
        record.inputs["src/package.json"],
        createHash("sha256").update(metadata).digest("hex"),
      );
    },
  );
});
