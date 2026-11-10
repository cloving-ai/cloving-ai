import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { turn } from "./claude-profiles-fixture.ts";
import { fakeEngine } from "./claude-runner-fixture.ts";
import {
  git,
  withScene,
  type Scene,
  type WorkerOverrides,
} from "./claude-worker-fixture.ts";
import type { TurnProfile } from "../src/turn-profile.ts";

function printer(scene: Scene): readonly string[] {
  const script = join(scene.directory, "git-config-worker.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
for await (const chunk of process.stdin) String(chunk);
const read = (key) => spawnSync("git", ["config", "--get", key], { encoding: "utf8" }).stdout.trim();
const config = { commit: read("commit.gpgsign"), tag: read("tag.gpgsign"), safe: read("safe.directory"), fixture: read("core.fixture") };
console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ config }) }));
`,
  );
  return [process.execPath, script];
}

async function observed(
  scene: Scene,
  options: {
    readonly profile: TurnProfile;
    readonly settings?: WorkerOverrides;
  },
): Promise<unknown> {
  git(scene.repository, ["config", "commit.gpgsign", "true"]);
  git(scene.repository, ["config", "tag.gpgsign", "true"]);
  const seen = await turn(scene, {
    method: "run-turn:signed",
    settings: {
      command: printer(scene),
      profiles: { signed: options.profile },
      ...options.settings,
    },
  });
  return seen["config"];
}

const fixtureEntry = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fixture",
  GIT_CONFIG_VALUE_0: "profile",
};

await test("CLV-344 a turn keeps the commit signature settings of the repository by default", () =>
  withScene(async (scene) => {
    assert.deepEqual(await observed(scene, { profile: {} }), {
      commit: "true",
      tag: "true",
      safe: "",
      fixture: "",
    });
  }));

await test("CLV-344 with turns.commitSignatures off a turn commits and tags with no signature, after the git settings it already has", () =>
  withScene(async (scene) => {
    assert.deepEqual(
      await observed(scene, {
        profile: { env: fixtureEntry },
        settings: { turnCommitSignatures: "off" },
      }),
      { commit: "false", tag: "false", safe: "", fixture: "profile" },
    );
  }));

await test("CLV-344 with turns.commitSignatures off a container turn gets safe.directory and no commit signature", () =>
  withScene(async (scene) => {
    const engine = fakeEngine(scene.directory, { access: "write" });
    assert.deepEqual(
      await observed(scene, {
        profile: {
          runner: {
            kind: "container",
            engine: engine.path,
            image: "cloving-fixture",
          },
        },
        settings: { turnCommitSignatures: "off" },
      }),
      { commit: "false", tag: "false", safe: "*", fixture: "" },
    );
  }));
