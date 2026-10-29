import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { withDoctor } from "./doctor-fixture.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { operatorFiles } from "./workflow-folder-fixture.ts";

const entry = resolve("src/cli.ts");

await test("CLV-225 init-prompt has discoverable help and rejects unsupported arguments", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      timeout: 15000,
    });
  assert.match(cli("--help").stdout, /init-prompt/);
  assert.match(
    cli("init-prompt", "--help").stdout,
    /Usage: cloving init-prompt/,
  );
  for (const args of [["extra"], ["--json"], ["--repository"]]) {
    assert.equal(cli("init-prompt", ...args).status, 2);
  }
});

await test("CLV-225 init-prompt uses the configured GitHub command and user folder from a nested directory", () =>
  withDoctor(async (scene) => {
    for (const [name, text] of Object.entries(
      operatorFiles("user", "custom"),
    )) {
      const file = join(
        scene.root,
        name.replace("config/cloving/workflows", "own-workflows"),
      );
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    const command = await scene.program(
      "github-reader",
      'if (process.argv[2] !== "--read") process.exit(92); console.log("custom-user")',
    );
    const file = privateSettingsPath(scene.environment, scene.repository);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        github: { command: [command, "--read"] },
        workflows: { folder: join(scene.root, "own-workflows") },
        harness: { name: "aider", turn: ["aider", "--message", "{prompt}"] },
      }),
    );
    const nested = join(scene.repository, "nested");
    await mkdir(nested);
    const result = spawnSync(process.execPath, [entry, "init-prompt"], {
      cwd: nested,
      env: scene.environment,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /custom-user/);
    assert.match(result.stdout, /one-shot aider/);
    assert.match(result.stdout, /"workflowId": "custom"/);
    assert.match(
      result.stdout,
      /Explain each existing project and user workflow/,
    );
    assert.ok(result.stdout.includes(scene.repository));
    const mismatched = spawnSync(process.execPath, [entry, "init-prompt"], {
      cwd: nested,
      env: { ...scene.environment, CLOVING_WORKER: "amp" },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(mismatched.status, 0, mismatched.stderr);
    assert.match(mismatched.stdout, /no worker; ask for harness.turn/);
    assert.doesNotMatch(mismatched.stdout, /one-shot amp/);
  }));

await test("CLV-225 missing origin, login and native worker are explicit facts", () =>
  withDoctor((scene) => {
    const result = spawnSync(
      process.execPath,
      [entry, "init-prompt", "--repository", scene.repository],
      {
        env: {
          ...scene.environment,
          CLOVING_WORKER: "aider",
          CLOVING_GH_COMMAND: '["missing-gh"]',
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"login": "unavailable"/);
    assert.match(result.stdout, /no worker; ask for harness.turn/);
    const invalid = spawnSync(
      process.execPath,
      [entry, "init-prompt", "--repository", join(scene.root, "absent")],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /init-prompt-failed/);
  }));
