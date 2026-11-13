import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { chooseHarness } from "../src/cli/init-selection.ts";
import { createProbeRunner } from "../src/cli/probe-command.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";

const selections = ["file", "path", "shell", "profile"] as const;
const probe = createProbeRunner({
  spawn: (input) => spawn(input.executable, input.arguments, input.options),
  kill: (identifier, signal) => process.kill(identifier, signal),
});

async function legacyPi(scene: DoctorScene, selection: string) {
  const shell = selection === "shell";
  const program = await scene.program(
    shell ? "receiver" : "pi",
    'if (process.argv[2] === "--version") console.log("custom pi 9.8.7"); else { console.log(JSON.stringify(process.argv.slice(2))); process.exit(7); }',
  );
  await writeFile(
    join(scene.root, ".zshrc"),
    `pi() { ${JSON.stringify(program)} "$@"; }\n`,
  );
  const kind: "file" | "shell" = shell ? "shell" : "file";
  const harness = {
    name: "pi",
    kind,
    path: shell ? "pi" : program,
    turn: [shell ? "pi" : program, "{prompt}"],
  };
  const settings = {
    version: 1,
    harness,
    profiles: { legacy: { harness: "pi", env: { TURN_VALUE: "kept" } } },
  };
  const file = privateSettingsPath(scene.environment, scene.repository);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings));
  const environment = {
    ...scene.environment,
    SHELL: shell ? "/bin/zsh" : "/missing-shell",
    ZDOTDIR: scene.root,
    ...(selection === "profile" ? { CLOVING_WORKER: "claude" } : {}),
  };
  return { program, file, harness, settings, environment };
}

for (const selection of selections) {
  await test(`CLV-373 init preserves a v1.9 custom text pi ${selection} selection`, () =>
    withDoctor(async (scene) => {
      const legacy = await legacyPi(scene, selection);
      const target = {
        file: "pi",
        path: legacy.program,
        shell: "shell:pi",
        profile: "pi",
      }[selection];
      const result = initCli(scene, {
        arguments: ["--harness", target],
        environment: legacy.environment,
      });
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        "run `cloving init-prompt`",
      ]);
      assert.deepEqual(
        JSON.parse(await readFile(legacy.file, "utf8")),
        legacy.settings,
      );
    }));
}

for (const selection of ["file", "shell"]) {
  await test(`CLV-373 the picker rediscovers the matching custom pi ${selection} default`, () =>
    withDoctor(async (scene) => {
      const legacy = await legacyPi(scene, selection);
      const selected = await chooseHarness({
        environment: legacy.environment,
        current: legacy.harness,
        probe,
        question: () => Promise.resolve(""),
      });
      assert.equal(selected.name, "pi");
      assert.equal(selected.kind, legacy.harness.kind);
      assert.equal(selected.path, legacy.harness.path);
      assert.equal(selected.version, "custom pi 9.8.7");
    }));

  await test(`CLV-373 setup facts discover custom pi ${selection} as a text worker`, () =>
    withDoctor(async (scene) => {
      const legacy = await legacyPi(scene, selection);
      const result = spawnSync(
        process.execPath,
        [resolve("src/cli.ts"), "init-prompt"],
        {
          cwd: scene.repository,
          env: legacy.environment,
          encoding: "utf8",
          timeout: 15000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"worker": "one-shot pi"/);
      assert.match(
        result.stdout,
        /"name": "pi",\s*"version": "custom pi 9\.8\.7",\s*"working": true/,
      );
    }));

  await test(`CLV-373 doctor discovery qualifies the matching custom pi ${selection}`, () =>
    withDoctor(async (scene) => {
      const legacy = await legacyPi(scene, selection);
      const discovery = check(
        await scene.report(legacy.environment),
        "harnesses",
      );
      assert.match(
        String(discovery["detail"]),
        /"name":"pi"[^}]*"version":"custom pi 9\.8\.7","working":true/,
      );
    }));
}

for (const mismatch of ["turn", "name", "kind", "path"]) {
  await test(`CLV-373 a saved ${mismatch} mismatch cannot loosen native Pi qualification`, () =>
    withDoctor(async (scene) => {
      const legacy = await legacyPi(scene, "file");
      await writeFile(
        legacy.file,
        JSON.stringify({
          ...legacy.settings,
          harness: {
            ...legacy.harness,
            ...(mismatch === "turn" ? { turn: undefined } : {}),
            ...(mismatch === "name" ? { name: "custom" } : {}),
            ...(mismatch === "kind" ? { kind: "shell" } : {}),
            ...(mismatch === "path" ? { path: "other-pi" } : {}),
          },
        }),
      );
      const result = initCli(scene, {
        arguments: ["--harness", legacy.program],
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /harness-unusable/);
    }));
}
