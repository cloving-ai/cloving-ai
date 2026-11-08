import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isProfilesFile } from "../src/turn-profile.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";
import { capturedSetting } from "./daemon-settings-capture.ts";

await test("CLV-086 start snapshots profiles once and preserves every allowed profile name in daemon settings", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const file = join(fixture.root, "profiles.json");
    const profiles = {
      ["__proto__"]: {
        env: { TURN_NAME: "{turn}" },
        workflows: ["review-loop"],
      },
      checker: { maxBudgetUsd: 15 },
    };
    writeFileSync(file, JSON.stringify({ profiles }));
    const daemon = await fixture.start({ CLOVING_PROFILES: file });
    assert.equal(await ended(daemon), 0);
    writeFileSync(file, "no longer valid JSON");
    const parsedProfiles = capturedSetting({
      directory: fixture.directory,
      field: "profiles",
    });
    const captured = { profiles: parsedProfiles };
    assert.ok(isProfilesFile(captured));
    assert.deepEqual(captured.profiles, profiles);
  }));
