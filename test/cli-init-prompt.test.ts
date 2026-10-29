import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { operatorFiles } from "./workflow-folder-fixture.ts";
import { settings, withDoctor } from "./doctor-fixture.ts";

await test("CLV-225 init-prompt prints facts and setup instructions without running a worker", () =>
  withDoctor(async (scene) => {
    await scene.program(
      "gh",
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["api", "user", "--jq", ".login"])) process.exit(91); console.log("setup-user")',
    );
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "init-prompt"],
      { cwd: scene.repository, env: scene.environment, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# Facts\n/);
    assert.ok(result.stdout.includes(scene.repository));
    assert.match(result.stdout, /git@github.com:example\/project.git/);
    assert.match(result.stdout, /setup-user/);
    assert.ok(result.stdout.includes(process.version));
    assert.match(result.stdout, /codex[\s\S]*0\.100\.0/);
    assert.match(result.stdout, /claude[\s\S]*2\.1\.1/);
    assert.match(result.stdout, /# Rules\n/);
    assert.match(result.stdout, /# Steps\n/);
    assert.match(result.stdout, /Make the first workflow/);
    assert.match(result.stdout, /develop.*5 decision points/);
    assert.equal(result.stderr, "");
  }));

await test("CLV-225 project and user workflows get change steps and loader facts", () =>
  withDoctor(async (scene) => {
    const files = {
      ...operatorFiles("project", "projectwork"),
      ...operatorFiles("user", "userwork"),
    };
    for (const [name, text] of Object.entries(files)) {
      const file = join(scene.root, name.replace("repo/", "repository/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "init-prompt"],
      {
        cwd: scene.repository,
        env: scene.environment,
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Explain each existing project and user workflow/,
    );
    assert.match(result.stdout, /projectwork/);
    assert.match(result.stdout, /userwork/);
    assert.doesNotMatch(result.stdout, /Make the first workflow/);
    assert.doesNotMatch(result.stdout, /4\. Ask which workflow to make first/);
  }));

await test("CLV-225 config alone gets first-workflow steps and private texts stay private", () =>
  withDoctor(async (scene) => {
    await settings(scene, {
      version: 1,
      checks: { beforeMerge: ["npm", "test"] },
    });
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "init-prompt"],
      {
        cwd: scene.repository,
        env: scene.environment,
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Make the first workflow/);
    assert.match(result.stdout, /\.cloving\/config\.json/);
    assert.doesNotMatch(result.stdout, /private example/);
  }));
