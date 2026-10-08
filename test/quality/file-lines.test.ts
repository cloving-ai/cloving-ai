import assert from "node:assert/strict";
import { test } from "node:test";
import { lintFixture } from "./lint-fixture.ts";

for (const filename of [
  "source.ts",
  "source.js",
  "source.test.ts",
  "source.test.js",
]) {
  await test(`QG-02 counts physical lines in ${filename}`, () => {
    const boundary = "\n".repeat(399) + "export const value = 1;\n";
    assert.deepEqual(lintFixture(boundary, filename), []);
    const exceeded = lintFixture("\n" + boundary, filename);
    assert.deepEqual(
      exceeded.map((message) => message.ruleId),
      ["max-lines"],
    );
    assert.match(exceeded[0]?.message ?? "", /401.*400/);
  });
}
