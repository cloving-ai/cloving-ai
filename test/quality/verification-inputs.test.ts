import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureVerificationInputs } from "../../quality/verification-inputs.ts";
import { withFiles } from "./files-fixture.ts";

const files = {
  "main.ts": "export const value = 1;",
  "main.test.ts": "export {};",
  "package-lock.json": "{}",
  "tool.js": "process.exit(0);",
  "policy.json": "{}",
  "exceptions.json": "[]",
};

for (const [kind, name] of [
  ["source", "main.ts"],
  ["tests", "main.test.ts"],
  ["dependencies", "package-lock.json"],
  ["tools", "tool.js"],
  ["policy", "policy.json"],
  ["exceptions", "exceptions.json"],
] as const) {
  await test(`QG-11 binds changed ${kind} bytes to verification inputs`, async () => {
    await withFiles(files, async (directory) => {
      const inventory = {
        source: [join(directory, "main.ts")],
        tests: [join(directory, "main.test.ts")],
        dependencies: [join(directory, "package-lock.json")],
        tools: [join(directory, "tool.js")],
        policy: [join(directory, "policy.json")],
        exceptions: [join(directory, "exceptions.json")],
      };
      const before = await captureVerificationInputs(inventory);
      await writeFile(join(directory, name), "changed");
      assert.notEqual(await captureVerificationInputs(inventory), before);
    });
  });
}

await test("QG-11 binds executable modes and rejects empty required input groups", async () => {
  await withFiles(files, async (directory) => {
    const file = join(directory, "tool.js");
    const inventory = {
      source: [file],
      tests: [file],
      dependencies: [file],
      tools: [file],
      policy: [file],
      exceptions: [],
    };
    const before = await captureVerificationInputs(inventory);
    await chmod(file, 0o700);
    assert.notEqual(await captureVerificationInputs(inventory), before);
    await assert.rejects(
      captureVerificationInputs({ ...inventory, source: [] }),
      /empty-verification-inputs/,
    );
  });
});
