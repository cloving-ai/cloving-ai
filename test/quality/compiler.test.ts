import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { compilerProgram } from "../../quality/compiler.ts";
import { withFiles } from "./files-fixture.ts";

const config = JSON.stringify({
  extends: resolve("tsconfig.json"),
  compilerOptions: { rootDir: ".", types: [] },
  include: ["**/*"],
  exclude: [],
});

await test("QG-01 compiler checks exactly the supplied source inventory", async () => {
  await withFiles(
    {
      "package.json": '{"type":"module"}',
      "tsconfig.json": config,
      "main.ts": "export const value = 1;",
    },
    (directory) => {
      const files = [join(directory, "main.ts")];
      assert.deepEqual(
        compilerProgram(directory, { files }).getRootFileNames(),
        files,
      );
    },
  );
});

for (const [name, source, configuration, message] of [
  [
    "type error",
    "export const value: number = undefined;",
    config,
    /compiler diagnostics/i,
  ],
  [
    "malformed config",
    "export const value = 1;",
    "{ malformed",
    /compiler configuration/i,
  ],
  [
    "omitted source",
    "export const value = 1;",
    JSON.stringify({ compilerOptions: { strict: true }, files: ["other.ts"] }),
    /compiler inventory/i,
  ],
] as const) {
  await test(`QG-10 rejects ${name}`, async () => {
    await withFiles(
      {
        "package.json": '{"type":"module"}',
        "tsconfig.json": configuration,
        "main.ts": source,
      },
      (directory) => {
        assert.throws(
          () =>
            compilerProgram(directory, { files: [join(directory, "main.ts")] }),
          message,
        );
      },
    );
  });
}
