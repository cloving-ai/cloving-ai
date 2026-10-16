import assert from "node:assert/strict";
import { test } from "node:test";
import { refusedStart } from "./cli-start-fixture.ts";

await test("CLV-085 start refuses an invalid self-update interval before compiling", async () => {
  assert.match(
    await refusedStart({ CLOVING_SELF_UPDATE_SECONDS: "10" }),
    /invalid-self-update-seconds/,
  );
});

await test("CLV-085 start refuses self-update for another repository", async () => {
  assert.match(
    await refusedStart({ CLOVING_SELF_UPDATE_SECONDS: "120" }),
    /self-update-needs-own-repository/,
  );
});
