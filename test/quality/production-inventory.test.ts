import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import { productionInventory } from "../../quality/production-inventory.ts";
import { withProgram } from "./program-fixture.ts";

await test("QG-18 production coverage follows admitted roles across renamed directories", async () => {
  await withProgram(
    {
      "relocated/main.ts": "export const value = 1;",
      "spec.test.ts": "export {};",
    },
    (program) => {
      const files = program.getRootFileNames();
      const roles = Object.fromEntries(
        files.map((file) => [
          file,
          file.endsWith("spec.test.ts") ? "test" : "pure",
        ]),
      );
      assert.deepEqual(
        productionInventory(program, { files, roles }).map((file) =>
          basename(file),
        ),
        ["main.ts"],
      );
      assert.throws(
        () => productionInventory(program, { files, roles: {} }),
        /unmapped-coverage-source/,
      );
    },
  );
});

await test("QG-18 declarations and unknown source roles require explicit qualification", async () => {
  await withProgram(
    { "contract.d.ts": "export interface Contract { value: string; }" },
    (program) => {
      const files = program.getRootFileNames();
      assert.throws(
        () =>
          productionInventory(program, {
            files,
            roles: Object.fromEntries(files.map((file) => [file, "pure"])),
          }),
        /unadmitted-coverage-declaration/,
      );
      assert.throws(
        () =>
          productionInventory(program, {
            files,
            roles: Object.fromEntries(files.map((file) => [file, "hidden"])),
          }),
        /unqualified-coverage-role/,
      );
    },
  );
});
