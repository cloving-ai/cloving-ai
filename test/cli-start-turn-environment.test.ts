import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { refusedStart } from "./cli-start-fixture.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";

await test("CLV-310 start reads turns.environment into daemon settings", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const child = await fixture.start({
      CLOVING_TURN_ENVIRONMENT: '["DATABASE_URL"]',
    });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(
        launcher.includes('\\"turnVariables\\":[\\"DATABASE_URL\\"]'),
        launcher,
      );
    } finally {
      assert.equal(await ended(child), 0);
    }
  }));

await test("CLV-310 start refuses an invalid turns.environment and names the variable", async () => {
  assert.match(
    await refusedStart({
      CLOVING_TURN_ENVIRONMENT: "all",
      CLOVING_SELF_UPDATE_SECONDS: undefined,
    }),
    /invalid-setting: CLOVING_TURN_ENVIRONMENT/,
  );
});

await test("CLV-344 start reads turns.commitSignatures into daemon settings", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const child = await fixture.start({
      CLOVING_TURN_COMMIT_SIGNATURES: "off",
    });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(
        launcher.includes('\\"turnCommitSignatures\\":\\"off\\"'),
        launcher,
      );
    } finally {
      assert.equal(await ended(child), 0);
    }
  }));

await test("CLV-344 start refuses an invalid turns.commitSignatures and names the variable", async () => {
  assert.match(
    await refusedStart({
      CLOVING_TURN_COMMIT_SIGNATURES: "never",
      CLOVING_SELF_UPDATE_SECONDS: undefined,
    }),
    /invalid-setting: CLOVING_TURN_COMMIT_SIGNATURES/,
  );
});
