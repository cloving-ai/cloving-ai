import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isProfilesFile } from "../src/turn-profile.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";
import { capturedSetting } from "./daemon-settings-capture.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";

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

for (const worker of ["pi", "claude"]) {
  await test(`CLV-373 startup retains native Pi command overrides with default worker ${worker}`, () =>
    withoutChildren(async () => {
      const fixture = await scene();
      const config = join(fixture.root, "config");
      mkdirSync(join(config, "cloving/projects"), { recursive: true });
      writeFileSync(
        privateSettingsPath({ XDG_CONFIG_HOME: config }, fixture.repository),
        JSON.stringify({
          version: 1,
          harness: { name: "pi", command: ["saved-pi", "--mode", "json"] },
          profiles: { native: { harness: "pi" } },
        }),
      );
      const command = ["selected-pi", "--mode", "json", "--thinking", "high"];
      const daemon = await fixture.start({
        XDG_CONFIG_HOME: config,
        CLOVING_WORKER: worker,
        CLOVING_PI_COMMAND: JSON.stringify(command),
        CLOVING_PROFILES: undefined,
      });
      assert.equal(await ended(daemon), 0);
      const workerCommands = capturedSetting({
        directory: fixture.directory,
        field: "workerCommands",
      });
      assert.deepEqual(Reflect.get(Object(workerCommands), "pi"), command);
      assert.deepEqual(
        capturedSetting({ directory: fixture.directory, field: "command" }),
        worker === "pi"
          ? command
          : [process.execPath, join(fixture.root, "fake-claude.mjs")],
      );
    }));
}

await test("CLV-373 startup ignores native Pi command variables for a declared custom Pi text turn", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const config = join(fixture.root, "config");
    mkdirSync(join(config, "cloving/projects"), { recursive: true });
    writeFileSync(
      privateSettingsPath({ XDG_CONFIG_HOME: config }, fixture.repository),
      JSON.stringify({
        version: 1,
        harness: { name: "pi", turn: ["custom-pi"] },
      }),
    );
    const daemon = await fixture.start({
      XDG_CONFIG_HOME: config,
      CLOVING_PI_COMMAND: "must-be-ignored",
      CLOVING_PROFILES: undefined,
    });
    assert.equal(await ended(daemon), 0);
    assert.deepEqual(
      capturedSetting({ directory: fixture.directory, field: "command" }),
      ["custom-pi"],
    );
    assert.equal(
      Reflect.get(
        Object(
          capturedSetting({
            directory: fixture.directory,
            field: "workerCommands",
          }),
        ),
        "pi",
      ),
      undefined,
    );
  }));
