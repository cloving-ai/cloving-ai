import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectFixture } from "./structure-fixture.ts";

for (const source of [
  "export function example(flag: boolean) { return flag; }",
  "type Flag = boolean; export function example(flag: Flag) { return flag; }",
  "export function example(flag?: boolean) { return flag; }",
  "export function example(flag = false) { return flag; }",
  "export const example = (flag: true | undefined) => flag;",
]) {
  await test(`QG-13 rejects positional boolean: ${source}`, async () => {
    const findings = await inspectFixture({ "fixture.ts": source });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "no-boolean-parameter");
    assert.equal(findings[0].line, 1);
  });
}

await test("QG-13 permits a named options object", async () => {
  const findings = await inspectFixture({
    "fixture.ts":
      "export function example(options: { enabled: boolean }) { return options.enabled; }",
  });
  assert.deepEqual(findings, []);
});
