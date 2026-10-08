import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import { graphFixture } from "./graph-fixture.ts";

await test("QG-19 retains aliases, barrels, type-only edges and builtins", async () => {
  const graph = await graphFixture({
    "main.ts":
      'import type { Value } from "./barrel.js"; import { readFile } from "fs"; export type Result = Value;',
    "barrel.ts": 'export type { Value } from "#local";',
    "data.ts": "export interface Value { value: number }",
  });
  assert.equal(graph.files.length, 3);
  assert.deepEqual(
    graph.edges.map((edge) => ({
      from: basename(edge.from),
      target: basename(edge.target),
      kind: edge.kind,
    })),
    [
      { from: "barrel.ts", target: "data.ts", kind: "type" },
      { from: "main.ts", target: "barrel.ts", kind: "type" },
      { from: "main.ts", target: "node:fs", kind: "value" },
    ],
  );
});

await test("QG-19 resolves conditional package exports for import and require modes", async () => {
  const graph = await graphFixture({
    "main.mts": 'import type { Value } from "example";',
    "main.cts": 'import type { Value } from "example";',
    "node_modules/example/package.json": JSON.stringify({
      name: "example",
      type: "module",
      exports: { import: "./import.d.mts", require: "./require.d.cts" },
    }),
    "node_modules/example/import.d.mts": "export type Value = string;",
    "node_modules/example/require.d.cts": "export type Value = number;",
  });
  assert.deepEqual(
    graph.edges.map((edge) => basename(edge.target)),
    ["require.d.cts", "import.d.mts"],
  );
});

for (const [source, rule] of [
  ['import { missing } from "./missing.js";', "unresolved-import"],
  ['await import("node:fs");', "unsupported-loading"],
  ['const load = require; load("fs");', "unsupported-loading"],
  ['const loaded = module["require"]("node:fs");', "unsupported-loading"],
  ['type Value = import("node:fs").Stats;', "unsupported-loading"],
] as const) {
  await test(`QG-19 rejects ${rule}: ${source}`, async () => {
    await assert.rejects(graphFixture({ "main.ts": source }), new RegExp(rule));
  });
}

await test("QG-19 rejects an unqualified first-party runtime hidden behind a declaration", async () => {
  await assert.rejects(
    graphFixture({
      "main.ts":
        'import { value } from "./helper.js"; export const result = value;',
      "helper.d.ts": "export declare const value: number;",
      "helper.js": 'import { value } from "./storage.js"; export { value };',
      "storage.js": "export const value = 1;",
    }),
    /unqualified-runtime-target/,
  );
});

await test("QG-19 retains runtime loading from inline type import and export bindings", async () => {
  const graph = await graphFixture({
    "main.ts":
      'import { type Value } from "./data.js"; export { type Value } from "./data.js";',
    "data.ts": "export interface Value { value: number }",
  });
  assert.deepEqual(
    graph.edges.map((edge) => edge.kind),
    ["value", "value"],
  );
});

await test("QG-19 rejects a declaration split behind inline type bindings", async () => {
  await assert.rejects(
    graphFixture({
      "main.ts":
        'import { type Value } from "./helper.js"; export type Result = Value;',
      "helper.d.ts": "export interface Value { value: number }",
      "helper.js": 'import { value } from "./storage.js"; export { value };',
      "storage.js": "export const value = 1;",
    }),
    /unqualified-runtime-target/,
  );
});

await test("QG-19 permits require as an inert conditional-export object key", async () => {
  const graph = await graphFixture({
    "main.ts":
      'export const exports = { import: "./import.js", require: "./require.cjs" };',
  });
  assert.deepEqual(graph.edges, []);
});
