import assert from "node:assert/strict";
import { test } from "node:test";
import { integer, optionalInteger, text } from "../src/storage/domain-rows.ts";

await test("CLV-007 a stored row with a missing or mistyped column is rejected instead of coerced", () => {
  assert.equal(text({ type: "run.created" }, "type"), "run.created");
  assert.equal(integer({ sequence: 4 }, "sequence"), 4);
  assert.equal(integer({ sequence: 4n }, "sequence"), 4);
  assert.equal(optionalInteger({ sequence: null }, "sequence"), null);
  for (const [read, row, name] of [
    [text, {}, "type"],
    [text, { type: 1 }, "type"],
    [integer, { sequence: "4" }, "sequence"],
    [integer, { sequence: 2 ** 53 }, "sequence"],
    [integer, { sequence: 2n ** 53n }, "sequence"],
    [integer, { sequence: null }, "sequence"],
    [integer, { sequence: true }, "sequence"],
    [integer, { sequence: "" }, "sequence"],
    [integer, undefined, "sequence"],
    [optionalInteger, { sequence: "4" }, "sequence"],
  ] as const)
    assert.throws(() => read(row, name), new Error(`invalid-column: ${name}`));
});
