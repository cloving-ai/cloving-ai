import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTypedFixture } from "./typed-fixture.ts";

await test("QG-16 validated unknown and exhaustive outcomes pass", async () => {
  const result = await inspectTypedFixture({
    "fixture.ts": `
    export function validate(value: unknown): number {
      if (typeof value !== "number") throw new Error("Expected number");
      return value;
    }
    export function outcome(value: "pass" | "fail"): number {
      switch (value) { case "pass": return 1; case "fail": return 0; }
    }
  `,
  });
  assert.deepEqual(result.compiler, []);
  assert.deepEqual(
    result.lint.flatMap((file) => file.messages),
    [],
  );
});

for (const [name, source, rule] of [
  [
    "inferred any",
    'export const value = JSON.parse("1");',
    "no-unsafe-assignment",
  ],
  [
    "unsafe cast",
    'export const value = JSON.parse("1") as number;',
    "no-unsafe-type-assertion",
  ],
  [
    "missing outcome",
    'export function outcome(value: "pass" | "fail") { switch(value) { case "pass": return 1; default: return 0; } }',
    "switch-exhaustiveness-check",
  ],
] as const) {
  await test(`QG-16 rejects ${name}`, async () => {
    const result = await inspectTypedFixture({ "fixture.ts": source });
    const messages = result.lint.flatMap((file) => file.messages);
    assert.equal(
      messages.some((message) => message.fatal),
      false,
    );
    assert.ok(
      messages.some(
        (message) => message.ruleId === `@typescript-eslint/${rule}`,
      ),
      JSON.stringify(messages),
    );
  });
}

await test("QG-16 rejects imported inferred any", async () => {
  const result = await inspectTypedFixture({
    "provider.ts": 'export const value = JSON.parse("1");',
    "fixture.ts":
      'import { value } from "./provider.js"; export const result: number = value;',
  });
  const consumer = result.lint.find((file) =>
    file.filePath.endsWith("fixture.ts"),
  );
  assert.ok(
    consumer?.messages.some(
      (message) => message.ruleId === "@typescript-eslint/no-unsafe-assignment",
    ),
  );
});

for (const [name, source, diagnostic] of [
  [
    "unchecked index",
    "export function first(values: number[]): number { return values[0]; }",
    2322,
  ],
  [
    "explicit undefined optional",
    "export const value: { name?: string } = { name: undefined };",
    2375,
  ],
  ["implicit any", "export function identity(value) { return value; }", 7006],
] as const) {
  await test(`QG-16 compiler rejects ${name}`, async () => {
    const result = await inspectTypedFixture({ "fixture.ts": source });
    assert.ok(
      result.compiler.some((finding) => finding.code === diagnostic),
      result.compiler.map((finding) => finding.code).join(","),
    );
  });
}
