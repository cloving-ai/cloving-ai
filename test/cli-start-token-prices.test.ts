import assert from "node:assert/strict";
import { test } from "node:test";
import { refusedStart } from "./cli-start-fixture.ts";

await test("CLV-105 invalid token prices stop daemon start and name the setting", async () => {
  for (const value of [
    "invalid JSON",
    "null",
    '{"model":{"input":-1,"cachedInput":0,"output":1}}',
  ])
    assert.match(
      await refusedStart({
        CLOVING_TOKEN_PRICES: value,
        CLOVING_SELF_UPDATE_SECONDS: undefined,
      }),
      /CLOVING_TOKEN_PRICES/,
    );
});
