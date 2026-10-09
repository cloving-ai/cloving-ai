import assert from "node:assert/strict";
import { test } from "node:test";
import { integer, text } from "../src/storage/authority-rows.ts";

await test("CLV-007 a stored row with a missing or mistyped column is rejected instead of coerced", () => {
  assert.equal(text({ type: "run.created" }, "type"), "run.created");
  assert.equal(integer({ sequence: 4 }, "sequence"), 4);
  for (const [read, row, name] of [
    [text, {}, "type"],
    [text, { type: 1 }, "type"],
    [integer, { sequence: "4" }, "sequence"],
    [integer, { sequence: 2 ** 53 }, "sequence"],
    [integer, undefined, "sequence"],
  ] as const)
    assert.throws(() => read(row, name), new Error(`invalid-column: ${name}`));
});
