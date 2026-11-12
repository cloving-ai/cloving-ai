import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chooseInitPath } from "../src/cli/init-command.ts";
import { withProject } from "./cli-fixture.ts";
import { withDoctor } from "./doctor-fixture.ts";

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
      "fake",
      `if (process.argv[2] === "--version") console.log("1.0.0");
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
    assert.match(
      result.stdout,
      /cloving init --factory` to add review, a plan, and regular maintenance/,
    );
    await assert.rejects(readFile(join(scene.repository, "started.json")));
    const workflow = await readFile(
      join(scene.repository, ".cloving/workflows/develop.ts"),
      "utf8",
    );
    assert.match(workflow, /localRound as developRound/);
    assert.doesNotMatch(workflow, /preparePull/);
  }));

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

await test("init rejects both path flags", () =>
  withProject({}, (cli) => {
    const result = cli(["init", "--local", "--factory"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /conflicting-option/);
  }));
