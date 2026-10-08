import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTypedFixture } from "./typed-fixture.ts";

for (const [name, source, rule] of [
  ["detached promise", "Promise.resolve(1);", "no-floating-promises"],
  ["void promise", "void Promise.resolve(1);", "no-floating-promises"],
  [
    "detached thenable",
    "declare const operation: PromiseLike<number>; operation.then((value) => value);",
    "no-floating-promises",
  ],
  [
    "async void callback",
    "declare function visit(callback: () => void): void; visit(async () => { await Promise.resolve(1); });",
    "no-misused-promises",
  ],
  [
    "promise condition",
    'if (Promise.resolve(1)) { throw new Error("Unexpected"); }',
    "no-misused-promises",
  ],
] as const) {
  await test(`QG-17 rejects ${name}`, async () => {
    const result = await inspectTypedFixture({
      "fixture.ts": `export {}; ${source}`,
    });
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

await test("QG-17 awaiting or returning a promise passes", async () => {
  const result = await inspectTypedFixture({
    "fixture.ts":
      "export async function operation() { return await Promise.resolve(1); } export function forward() { return Promise.resolve(1); }",
  });
  assert.deepEqual(result.compiler, []);
  assert.deepEqual(
    result.lint.flatMap((file) => file.messages),
    [],
  );
});
