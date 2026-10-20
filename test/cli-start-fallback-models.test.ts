import assert from "node:assert/strict";
import { test } from "node:test";
import { refusedStart } from "./cli-start-fixture.ts";

await test("CLV-139 malformed fallback models refuse daemon start with a fixed code", async () => {
  for (const value of [
    "",
    "{",
    "null",
    "{}",
    '"model"',
    "[1]",
    "[null]",
    '[""]',
    '["  "]',
    '["a","b","c","d"]',
  ])
    assert.match(
      await refusedStart({
        CLOVING_FALLBACK_MODELS: value,
        CLOVING_WORKER: "invalid",
        CLOVING_SELF_UPDATE_SECONDS: undefined,
      }),
      /The daemon did not start: invalid-fallback-models/,
    );
});
