import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectEffects } from "../../quality/effects.ts";
import { withProgram } from "./program-fixture.ts";

for (const expression of [
  "Date.now()",
  "Math.random()",
  "process.env.VALUE",
  "fetch('https://invalid.example')",
  "setTimeout(() => {}, 0)",
  "crypto.randomUUID()",
  "globalThis['process'].env.VALUE",
  "Function('return 1')()",
  "eval('1')",
  "(()=>1).constructor('return 1')()",
  "(()=>1)['constructor']('return 1')()",
  "new Intl.DateTimeFormat('en-US').format()",
  "({ process }).process.env.VALUE",
]) {
  await test(`QG-06 rejects ambient effect ${expression}`, async () => {
    await withProgram(
      { "main.ts": `export const value = ${expression};` },
      (program) => {
        assert.ok(
          inspectEffects(program, program.getRootFileNames()).length > 0,
        );
      },
    );
  });
}

for (const body of [
  "const clock = Date; return clock.now();",
  "const { env } = process; return env.VALUE;",
  "const math = Math; return math.random();",
  "const { random } = Math; return random();",
  "const key = 'random'; return Math[key]();",
]) {
  await test(`QG-06 rejects captured ambient capability: ${body}`, async () => {
    await withProgram(
      { "main.ts": `export function effect() { ${body} }` },
      (program) => {
        assert.ok(
          inspectEffects(program, program.getRootFileNames()).length > 0,
        );
      },
    );
  });
}

await test("QG-06 preserves shadowed names and pure recorded-input reduction", async () => {
  await withProgram(
    {
      "main.ts":
        "export function reduce(Date: { now: number }, previous: number) { return Math.max(previous, Date.now); }",
    },
    (program) => {
      assert.deepEqual(inspectEffects(program, program.getRootFileNames()), []);
    },
  );
});

await test("QG-06 treats declaration-backed property names as recorded data", async () => {
  await withProgram(
    {
      "snapshot.d.ts":
        "export interface Snapshot { process: number; Date: number; }",
      "main.ts":
        'import type { Snapshot } from "./snapshot.js"; export function reduce(snapshot: Snapshot) { return snapshot.process + snapshot.Date; }',
    },
    (program) => {
      assert.deepEqual(inspectEffects(program, program.getRootFileNames()), []);
    },
  );
});

await test("QG-06 checks executable class heritage expressions", async () => {
  await withProgram(
    {
      "main.ts":
        "export class Value extends (class { static readonly value = Date.now(); }) {}",
    },
    (program) => {
      assert.ok(inspectEffects(program, program.getRootFileNames()).length > 0);
    },
  );
});

await test("CLV-121 candidate restrictions preserve existing pure data inspection", async () => {
  await withProgram(
    {
      "main.ts": `export function inspect(value: object) {
        return [Buffer.byteLength("value"), Reflect.get(value, "key"),
          Reflect.ownKeys(value), Object.getPrototypeOf(value),
          Object.getOwnPropertyDescriptor(value, "key")];
      }`,
    },
    (program) => {
      assert.deepEqual(inspectEffects(program, program.getRootFileNames()), []);
    },
  );
});
