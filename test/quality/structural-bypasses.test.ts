import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectFixture } from "./structure-fixture.ts";

for (const source of [
  "export function toggle<T extends boolean>(flag: T) { return flag; }",
  "export function toggle(...args: [flag: boolean]) { return args[0]; }",
  "export function toggle(...args: [flag?: boolean]) { return args[0]; }",
  "export function toggle(...args: boolean[]) { return args[0]; }",
  "export function toggle<T extends boolean>(...args: [flag: T]) { return args[0]; }",
  "type Flag = boolean & { brand: 'Flag' }; export function toggle(flag: Flag) { return flag; }",
]) {
  await test(`QG-13 resolves positional boolean indirection: ${source}`, async () => {
    const findings = await inspectFixture({ "fixture.ts": source });
    assert.equal(findings[0]?.rule, "no-boolean-parameter");
  });
}

await test("QG-14 excludes primitive and tuple aliases from object-member limits", async () => {
  const findings = await inspectFixture({
    "fixture.ts":
      "export type Identifier = string; export type Result = [number, number, number]; export type Values = number[];",
  });
  assert.deepEqual(findings, []);
});

await test("QG-13 resolves constrained generic tuple outputs", async () => {
  const findings = await inspectFixture({
    "fixture.ts":
      "export function result<T extends [number, number, number, number]>(value: T): T { return value; }",
  });
  assert.equal(findings[0]?.rule, "max-tuple-results");
  assert.equal(findings[0].measured, 4);
});

await test("QG-13 rejects unbounded positional tuple results", async () => {
  const findings = await inspectFixture({
    "fixture.ts":
      "export function result(): [number, ...number[]] { return [1, 2, 3, 4]; }",
  });
  assert.equal(findings[0]?.rule, "max-tuple-results");
  assert.equal(findings[0].measured, "unbounded");
});

await test("QG-13 checks every tuple return alternative", async () => {
  const findings = await inspectFixture({
    "fixture.ts":
      "export function result(): [number, number, number, number] | undefined { return [1, 2, 3, 4]; }",
  });
  assert.equal(findings[0]?.rule, "max-tuple-results");
  assert.equal(findings[0].measured, 4);
});

for (const name of ["", "Example"]) {
  await test(`QG-14 counts members in class expressions named '${name}'`, async () => {
    const members = Array.from(
      { length: 25 },
      (_, index) => `method${String(index)}() {}`,
    ).join("\n");
    const findings = await inspectFixture({
      "fixture.ts": `export const Result = class ${name} { ${members} };`,
    });
    assert.equal(findings[0]?.rule, "max-type-callables");
    assert.equal(findings[0].measured, 25);
  });
}
