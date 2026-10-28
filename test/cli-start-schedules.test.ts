import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSettings } from "../src/project-settings.ts";
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

await test("CLV-179 the start guide attributes the schedule setting to the environment", () => {
  const { sources } = resolveSettings(
    { CLOVING_SCHEDULES: "{}" },
    { project: undefined, private: undefined },
  );
  assert.equal(sources["CLOVING_SCHEDULES"], "environment");
});
