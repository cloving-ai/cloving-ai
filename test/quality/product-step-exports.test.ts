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

await test("CLV-122 candidate source templates and ordinary directive text are inert data", async () => {
  await withFiles(
    {
      "package.json": manifest,
      "src/generator.ts":
        'export function source() { return `export async function proposed() { "use workflow"; }`; }\nconst name = "use step";',
      "src/steps/turn.ts": `${step("turn")}\nconst documentation = '"use workflow"';`,
    },
    async (directory) => {
      assert.deepEqual(await productStepExports(directory), {
        [join(directory, "src/steps/turn.ts")]: ["turn"],
      });
    },
  );
});

for (const [name, source] of Object.entries({
  workflow: 'export async function hidden() { "use workflow"; }',
  nested: 'export function outer() { async function hidden() { "use step"; } }',
  arrow: 'export const hidden = async () => { "use step"; };',
  plain: 'export function hidden() { "use step"; }',
  escaped: 'export async function hidden() { "use\\u0020step"; }',
  misplaced: 'export async function hidden() { const value = 1; "use step"; }',
  top: '"use workflow";',
  default: 'export default async function turn() { "use step"; }',
  generator: 'export async function* turn() { "use step"; }',
}))
  await test(`CLV-122 actual unqualified ${name} directive is still refused`, async () => {
    await withFiles(
      { "package.json": manifest, "src/steps/turn.ts": source },
      async (directory) => {
        await assert.rejects(
          productStepExports(directory),
          /unqualified-product-durable: steps\/turn\.ts/,
        );
      },
    );
  });
