import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  chooseInitPath,
  initCommand,
  localWorkerTurn,
} from "../src/cli/init-command.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { record } from "../src/protocol.ts";
import { withProject } from "./cli-fixture.ts";
import { withDoctor } from "./doctor-fixture.ts";

function assertNextCommands(stdout: string, repository: string) {
  for (const command of [
    `cloving start --repository ${repository}`,
    `cloving run develop --prompt "Add a test for the date parser" --repository ${repository}`,
    `cloving questions --repository ${repository}`,
    `cloving init --factory --repository ${repository}`,
  ])
    assert.ok(stdout.includes(command), command);
}

await test("the init path question selects a local task or a factory", async () => {
  assert.equal(
    await chooseInitPath({ question: () => Promise.resolve("1") }),
    "local",
  );
  assert.equal(
    await chooseInitPath({ question: () => Promise.resolve(" 2 ") }),
    "factory",
  );
  await assert.rejects(
    chooseInitPath({ question: () => Promise.resolve("9") }),
    /path-not-selected/,
  );
});

await test("init --local applies the preset and does not start the agent", () =>
  withDoctor(async (scene) => {
    const harness = await scene.program(
      "claude",
      `if (process.argv[2] === "--version") console.log("1.0.0 (Claude Code)");
else {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("started.json", "started");
  process.exit(7);
}`,
    );
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "init", "--local", "--harness", harness],
      { cwd: scene.repository, env: scene.environment, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recovery stop/);
    assert.match(result.stdout, /lessons none/);
    assert.match(result.stdout, /demo none/);
    assertNextCommands(result.stdout, scene.repository);
    await assert.rejects(readFile(join(scene.repository, "started.json")));
    const workflow = await readFile(
      join(scene.repository, ".cloving/workflows/develop.ts"),
      "utf8",
    );
    assert.match(workflow, /localRound as developRound/);
    assert.doesNotMatch(workflow, /preparePull/);
    const settings = record(
      JSON.parse(
        await readFile(
          privateSettingsPath(scene.environment, scene.repository),
          "utf8",
        ),
      ),
    );
    const saved = record(settings?.["harness"]);
    assert.ok(saved);
    assert.equal(saved["name"], "claude");
    assert.equal(saved["turn"], undefined);
  }));

await test("init --local refuses a custom agent that has no one-shot command", () =>
  withDoctor(async (scene) => {
    const harness = await scene.program("amp", 'console.log("1.0.0")');
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "init", "--local", "--harness", harness],
      { cwd: scene.repository, env: scene.environment, encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /harness-no-worker: amp/);
    await assert.rejects(
      readFile(join(scene.repository, ".cloving/workflows/develop.ts")),
    );
    await assert.rejects(
      readFile(privateSettingsPath(scene.environment, scene.repository)),
    );
  }));

await test("init --local stores a one-shot command for a custom agent", () =>
  withDoctor(async (scene) => {
    const harness = await scene.program("amp", 'console.log("1.0.0")');
    const status = await initCommand({
      repository: scene.repository,
      environment: scene.environment,
      probe: () =>
        Promise.resolve({
          stdout: "1.0.0\n",
          stderr: "",
          reason: null,
          exitCode: 0,
        }),
      harness,
      path: "local",
      askTurn: () => Promise.resolve('["amp","{prompt}"]'),
      applyLocal: () => Promise.resolve(0),
      start: () => Promise.resolve(0),
    });
    assert.equal(status, 0);
    const settings = record(
      JSON.parse(
        await readFile(
          privateSettingsPath(scene.environment, scene.repository),
          "utf8",
        ),
      ),
    );
    const saved = record(settings?.["harness"]);
    assert.ok(saved);
    assert.deepEqual(saved["turn"], ["amp", "{prompt}"]);
  }));

await test("a custom agent one-shot command must be a JSON list", async () => {
  assert.deepEqual(
    await localWorkerTurn({
      name: "amp",
      question: () => Promise.resolve(' ["amp","{prompt}"] '),
    }),
    ["amp", "{prompt}"],
  );
  await assert.rejects(
    localWorkerTurn({ name: "amp", question: () => Promise.resolve("nope") }),
    /harness-no-worker: amp/,
  );
  await assert.rejects(
    localWorkerTurn({ name: "amp", question: () => Promise.resolve("{") }),
    /harness-no-worker: amp/,
  );
});

await test("init --factory still starts the setup agent", () =>
  withDoctor(async (scene) => {
    const harness = await scene.program(
      "fake",
      `if (process.argv[2] === "--version") console.log("1.0.0");
else {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("started.json", JSON.stringify(process.argv.slice(2)));
  process.exit(7);
}`,
    );
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "init", "--factory", "--harness", harness],
      { cwd: scene.repository, env: scene.environment, encoding: "utf8" },
    );
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(scene.repository, "started.json"), "utf8"),
      ),
      ["run `cloving init-prompt`"],
    );
  }));

await test("start accepts the repository option after the command", () => {
  const refused = spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "start", "--repository", "/work/repo", "extra"],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unexpected-argument/);
  assert.doesNotMatch(refused.stderr, /unknown-command/);
  const missed = spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "--repository", "/work/repo", "start"],
    { encoding: "utf8" },
  );
  assert.match(missed.stderr, /unknown-command/);
});

await test("init rejects both path flags", () =>
  withProject({}, (cli) => {
    const result = cli(["init", "--local", "--factory"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /conflicting-option/);
  }));
