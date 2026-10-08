import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectFixture } from "./structure-fixture.ts";

await test("QG-13 permits three positional results and named results", async () => {
  const findings = await inspectFixture({
    "fixture.ts":
      "export function tuple(): [number, number, number] { return [1,2,3]; } export function named() { return {one:1,two:2,three:3,four:4}; }",
  });
  assert.deepEqual(findings, []);
});

for (const source of [
  "export function tuple(): [number, number, number, number] { return [1,2,3,4]; }",
  "export const tuple = () => [1,2,3,4] as const;",
  "export async function tuple(): Promise<[number, number, number, number]> { return [1,2,3,4]; }",
]) {
  await test(`QG-13 rejects four positional results: ${source}`, async () => {
    const findings = await inspectFixture({ "fixture.ts": source });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "max-tuple-results");
    assert.equal(findings[0].measured, 4);
  });
}
