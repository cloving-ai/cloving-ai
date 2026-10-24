import assert from "node:assert/strict";
import { test } from "node:test";
import { refusedStart } from "./cli-start-fixture.ts";

await test("CLV-179 start rejects malformed schedule JSON before launching the daemon", async () => {
  assert.match(
    await refusedStart({
      CLOVING_SCHEDULES: "[",
      CLOVING_SELF_UPDATE_SECONDS: undefined,
    }),
    /invalid-schedules/,
  );
});
