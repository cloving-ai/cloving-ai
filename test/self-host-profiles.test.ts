import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isProfilesFile } from "../src/turn-profile.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";
import { capturedSetting } from "./daemon-settings-capture.ts";

const profiles = {
  ["__proto__"]: {
    env: { TURN_NAME: "{turn}" },
    workflows: ["review-loop"],
  },
  checker: { maxBudgetUsd: 15 },
};

const captured = {
  profiles: undefined as unknown,
  permits: undefined as unknown,
};

await withoutChildren(async () => {
  const fixture = await scene();
  const file = join(fixture.root, "profiles.json");
  writeFileSync(file, JSON.stringify({ profiles }));
  const daemon = await fixture.start({
    CLOVING_PROFILES: file,
    CLOVING_WORKSPACE_PERMITS: "/workspace/control.sock",
  });
  assert.equal(await ended(daemon), 0);
  writeFileSync(file, "no longer valid JSON");
  captured.profiles = capturedSetting({
    directory: fixture.directory,
    field: "profiles",
  });
  captured.permits = capturedSetting({
    directory: fixture.directory,
    field: "workspacePermits",
  });
});

await test("CLV-086 start snapshots profiles once and preserves every allowed profile name in daemon settings", () => {
  const shown = { profiles: captured.profiles };
  assert.ok(isProfilesFile(shown));
  assert.deepEqual(shown.profiles, profiles);
});

await test("CLV-312 the start program gives the daemon queue the permit socket of the workspace supervisor", () => {
  assert.equal(captured.permits, "/workspace/control.sock");
});
