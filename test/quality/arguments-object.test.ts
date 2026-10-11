import assert from "node:assert/strict";
import { test } from "node:test";
import { lintFixture } from "./lint-fixture.ts";

const reader =
  "export function plan() { return [arguments[0], arguments[1], arguments[2]].join(':'); }";

for (const filename of ["fixture.js", "fixture.mjs", "fixture.ts"])
  await test(`CLV-008 a function that reads the arguments object is rejected in ${filename}`, () => {
    assert.deepEqual(
      [
        ...new Set(
          lintFixture(reader, filename).map((finding) => finding.ruleId),
        ),
      ],
      ["prefer-rest-params"],
    );
  });

await test("CLV-008 a function with a rest list is accepted by the arguments rule", () => {
  assert.deepEqual(
    lintFixture(
      "export function join(...values) { return values.join(':'); }",
      "fixture.mjs",
    ),
    [],
  );
});
