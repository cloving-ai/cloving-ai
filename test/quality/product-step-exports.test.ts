import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { productStepExports } from "../../quality/product-steps.ts";
import { withFiles } from "./files-fixture.ts";

const manifest = JSON.stringify({
  name: "cloving",
  version: "0.4.0",
  exports: {
    "./workflows/steps/turn": { import: "./dist/src/steps/turn.js" },
    "./workflows/steps/gate": { import: "./dist/src/steps/gate.js" },
  },
});
const step = (name: string): string =>
  `export async function ${name}(value: string) { "use step"; return value; }`;

await test("CLV-016 the admitted step exports of a candidate are the durable step functions that its package exports, by step file", async () => {
  await withFiles(
    {
      "package.json": manifest,
      "src/steps/turn.ts": `${step("turn")}\n${step("secondTurn")}`,
      "src/steps/gate.ts": step("gate"),
      "src/plain.ts": "export const plain = 1;",
    },
    async (directory) => {
      assert.deepEqual(await productStepExports(directory), {
        [join(directory, "src/steps/gate.ts")]: ["gate"],
        [join(directory, "src/steps/turn.ts")]: ["turn", "secondTurn"],
      });
    },
  );
  await withFiles(
    { "package.json": manifest, "src/steps/hidden.ts": step("hidden") },
    async (directory) => {
      await assert.rejects(
        productStepExports(directory),
        /unexported-product-step: \.\/dist\/src\/steps\/hidden\.js/,
      );
    },
  );
});
