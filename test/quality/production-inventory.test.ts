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

await test("CLV-008 a service module is production code for the coverage inventory", async () => {
  await withProgram(
    { "service/main.ts": "export const value = 1;" },
    (program) => {
      const files = program.getRootFileNames();
      assert.deepEqual(
        productionInventory(program, {
          files,
          roles: Object.fromEntries(files.map((file) => [file, "service"])),
        }).map((file) => basename(file)),
        ["main.ts"],
      );
    },
  );
});

await test("CLV-121 candidate adapters remain in the production coverage inventory", async () => {
  await withProgram({ "adapter.ts": "export const value = 1;" }, (program) => {
    const files = program.getRootFileNames();
    assert.deepEqual(
      productionInventory(program, {
        files,
        roles: Object.fromEntries(
          files.map((file) => [file, "candidate-adapter"]),
        ),
      }).map((file) => basename(file)),
      ["adapter.ts"],
    );
  });
});

await test("CLV-161 retained bundle storage remains in the production coverage inventory", async () => {
  await withProgram({ "bundles.ts": "export const value = 1;" }, (program) => {
    const files = program.getRootFileNames();
    assert.deepEqual(
      productionInventory(program, {
        files,
        roles: Object.fromEntries(
          files.map((file) => [file, "workflow-bundles"]),
        ),
      }).map((file) => basename(file)),
      ["bundles.ts"],
    );
  });
});

await test("CLV-187 the phone relay code is in the production coverage inventory", async () => {
  await withProgram({ "relay.ts": "export const value = 1;" }, (program) => {
    const files = program.getRootFileNames();
    assert.deepEqual(
      productionInventory(program, {
        files,
        roles: Object.fromEntries(files.map((file) => [file, "relay"])),
      }).map((file) => basename(file)),
      ["relay.ts"],
    );
  });
});
