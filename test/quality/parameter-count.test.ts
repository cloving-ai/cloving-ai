import assert from "node:assert/strict";
import { test } from "node:test";
import { lintFixture } from "./lint-fixture.ts";

for (const prefix of ["", "this: void,"]) {
  await test(`QG-13 five/six parameter boundary with '${prefix}' context`, () => {
    const parameters =
      "first: number, second: number, third: number, fourth: number, fifth: number";
    const allowed = `function example(${prefix}${parameters}) {}`;
    assert.deepEqual(lintFixture(allowed), []);
    const findings = lintFixture(
      `function example(${prefix}${parameters}, sixth: number) {}`,
    );
    assert.deepEqual(
      findings.map((finding) => finding.ruleId),
      ["@typescript-eslint/max-params"],
    );
  });
}

await test("QG-13 a non-void context counts toward parameter limits", () => {
  const findings = lintFixture(
    "function example(this: { value: number }, first: number, second: number, third: number, fourth: number, fifth: number) {}",
  );
  assert.deepEqual(
    findings.map((finding) => finding.ruleId),
    ["@typescript-eslint/max-params"],
  );
});
