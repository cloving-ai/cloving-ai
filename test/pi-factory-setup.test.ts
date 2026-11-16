import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { probeHarness } from "../src/agent-harnesses.ts";
import { chooseHarness } from "../src/cli/init-selection.ts";
import { createProbeRunner } from "../src/cli/probe-command.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";
import { terminalInit } from "./init-terminal-fixture.ts";

const kinds = ["file", "shell"] as const;
const setupMessage = ["run `cloving init-prompt`"];
const probe = createProbeRunner({
  spawn: (input) => spawn(input.executable, input.arguments, input.options),
  kill: (identifier, signal) => process.kill(identifier, signal),
});

function piBody(version: string): string {
  return [
    'if (process.argv[2] === "--version") {',
    "  if (process.argv.length !== 3) process.exit(91);",
    `  console.log(${JSON.stringify(version)});`,
    "} else {",
    "  console.log(JSON.stringify(process.argv.slice(2)));",
    "  process.exit(7);",
    "}",
  ].join("\n");
}

async function setupPi(
  scene: DoctorScene,
  input: { readonly kind: "file" | "shell"; readonly version: string },
) {
  const shell = input.kind === "shell";
  const program = await scene.program(
    shell ? "receiver" : "pi",
    piBody(input.version),
  );
  await writeFile(
    join(scene.root, ".zshrc"),
    `pi() { ${JSON.stringify(program)} "$@"; }\n`,
  );
  return {
    program,
    target: shell ? "shell:pi" : "pi",
    harness: { name: "pi", kind: input.kind, path: shell ? "pi" : program },
    file: privateSettingsPath(scene.environment, scene.repository),
    environment: {
      ...scene.environment,
      SHELL: shell ? "/bin/zsh" : "/missing-shell",
      ZDOTDIR: scene.root,
    },
  };
}

async function outsidePi(scene: DoctorScene): Promise<string> {
  const path = join(scene.root, "other", "pi");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!${process.execPath}\n${piBody("1.5.3")}\n`);
  await chmod(path, 0o755);
  return path;
}

async function saveSelection(file: string, harness: object): Promise<string> {
  const text = JSON.stringify({ version: 1, harness });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return text;
}

async function savedHarness(file: string): Promise<unknown> {
  const saved: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(typeof saved === "object" && saved !== null && "harness" in saved);
  return saved.harness;
}

function asked() {
  const prompts: string[] = [];
  return {
    prompts,
    question: (text: string) => {
      prompts.push(text);
      return Promise.resolve("");
    },
  };
}

for (const kind of kinds) {
  await test(`#819 v1.9 fresh factory setup launches a legacy Pi 1.5.3 ${kind}`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind, version: "1.5.3" });
      const result = initCli(scene, {
        arguments: ["--harness", pi.target],
        environment: pi.environment,
      });
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), setupMessage);
      assert.deepEqual(await savedHarness(pi.file), pi.harness);
    }));

  await test(`#819 v1.9 a saved setup-only Pi 1.5.3 ${kind} selection reaches factory setup`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind, version: "1.5.3" });
      await saveSelection(pi.file, pi.harness);
      const result = initCli(scene, {
        arguments: ["--harness", pi.target],
        environment: pi.environment,
      });
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), setupMessage);
      assert.deepEqual(await savedHarness(pi.file), pi.harness);
    }));

  await test(`#819 v1.9 the factory picker offers a saved setup-only Pi 1.5.3 ${kind}`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind, version: "1.5.3" });
      const answers = asked();
      const selected = await chooseHarness({
        environment: pi.environment,
        current: pi.harness,
        probe,
        purpose: "factory-setup",
        question: answers.question,
      });
      assert.deepEqual(
        { name: selected.name, kind: selected.kind, path: selected.path },
        pi.harness,
      );
      assert.equal(selected.version, "1.5.3");
      assert.match(answers.prompts[0] ?? "", /^ {2}1\. pi /);
    }));

  await test(`#819 the explicit factory flag launches a legacy Pi 1.5.3 ${kind}`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind, version: "1.5.3" });
      const result = initCli(scene, {
        arguments: ["--factory", "--harness", pi.target],
        environment: pi.environment,
      });
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), setupMessage);
      assert.deepEqual(await savedHarness(pi.file), pi.harness);
    }));

  await test(`#819 native local setup still refuses a saved setup-only Pi 1.5.3 ${kind}`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind, version: "1.5.3" });
      const text = await saveSelection(pi.file, pi.harness);
      const result = initCli(scene, {
        arguments: ["--local", "--harness", pi.target],
        environment: pi.environment,
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /harness-unusable: unsupported-version/);
      assert.equal(result.stdout, "");
      assert.equal(await readFile(pi.file, "utf8"), text);
      const answers = asked();
      await chooseHarness({
        environment: pi.environment,
        current: pi.harness,
        probe,
        purpose: "local-worker",
        question: answers.question,
      });
      assert.doesNotMatch(answers.prompts[0] ?? "", / pi /);
    }));

  await test(`#819 native local setup keeps a Pi 1.5.2 ${kind} selection`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind, version: "1.5.2" });
      const result = initCli(scene, {
        arguments: ["--local", "--harness", pi.target],
        environment: pi.environment,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await savedHarness(pi.file), pi.harness);
    }));
}

await test("#819 v1.9 the factory picker lists a fresh legacy Pi 1.5.3 file", () =>
  withDoctor(async (scene) => {
    const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
    const prompts: string[] = [];
    const selected = await chooseHarness({
      environment: pi.environment,
      current: undefined,
      probe,
      purpose: "factory-setup",
      question: (text) => {
        prompts.push(text);
        return Promise.resolve(/ {2}(\d+)\. pi /.exec(text)?.[1] ?? "none");
      },
    });
    assert.equal(prompts.length, 1);
    assert.deepEqual(
      { name: selected.name, kind: selected.kind, path: selected.path },
      pi.harness,
    );
    assert.equal(selected.version, "1.5.3");
  }));

await test("#819 v1.9 the factory picker offers a saved setup-only Pi 1.5.3 outside PATH", () =>
  withDoctor(async (scene) => {
    const harness = {
      name: "pi",
      kind: "file" as const,
      path: await outsidePi(scene),
    };
    const answers = asked();
    const selected = await chooseHarness({
      environment: scene.environment,
      current: harness,
      probe,
      purpose: "factory-setup",
      question: answers.question,
    });
    assert.deepEqual(
      { name: selected.name, kind: selected.kind, path: selected.path },
      harness,
    );
    assert.equal(selected.version, "1.5.3");
    assert.match(answers.prompts[0] ?? "", /^ {2}1\. pi /);
  }));

await test("#819 the local picker omits a saved setup-only Pi 1.5.3 outside PATH", () =>
  withDoctor(async (scene) => {
    const answers = asked();
    const selected = await chooseHarness({
      environment: scene.environment,
      current: { name: "pi", kind: "file", path: await outsidePi(scene) },
      probe,
      purpose: "local-worker",
      question: answers.question,
    });
    assert.equal(selected.name, "claude");
    assert.equal(answers.prompts.length, 1);
    assert.doesNotMatch(answers.prompts[0] ?? "", /\d+\. pi /);
  }));

await test("#819 v1.9 the factory picker Other choice accepts a Pi 1.5.3 path", () =>
  withDoctor(async (scene) => {
    const program = await outsidePi(scene);
    const prompts: string[] = [];
    const selected = await chooseHarness({
      environment: scene.environment,
      current: undefined,
      probe,
      purpose: "factory-setup",
      question: (text) => {
        prompts.push(text);
        return Promise.resolve(/ {2}(\d+)\. Other/.exec(text)?.[1] ?? program);
      },
    });
    assert.equal(prompts.length, 2);
    assert.deepEqual(
      { name: selected.name, kind: selected.kind, path: selected.path },
      { name: "pi", kind: "file", path: program },
    );
    assert.equal(selected.version, "1.5.3");
  }));

await test("#819 v1.9 the terminal factory picker launches a saved setup-only Pi 1.5.3", () =>
  withDoctor(async (scene) => {
    const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
    await saveSelection(pi.file, pi.harness);
    const result = await terminalInit(scene);
    assert.deepEqual(result.ended, [7, null], result.stdout + result.stderr);
    assert.equal(result.selected, true);
    assert.match(result.stdout, / {2}1\. pi /);
    assert.ok(result.stdout.includes(JSON.stringify(setupMessage)));
  }));

await test("#819 the terminal local picker omits a saved setup-only Pi 1.5.3", () =>
  withDoctor(async (scene) => {
    const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
    await saveSelection(pi.file, pi.harness);
    const result = await terminalInit(scene, { path: "local" });
    assert.deepEqual(result.ended, [0, null], result.stdout + result.stderr);
    assert.match(result.stdout, / {2}1\. claude /);
    assert.doesNotMatch(result.stdout, /\d+\. pi /);
    assert.deepEqual(await savedHarness(pi.file), {
      name: "claude",
      kind: "file",
      path: join(scene.root, "bin", "claude"),
    });
  }));

await test("#819 v1.9 an explicit factory harness overrides a saved setup-only Pi selection", () =>
  withDoctor(async (scene) => {
    const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
    await saveSelection(pi.file, pi.harness);
    const other = await outsidePi(scene);
    const result = initCli(scene, {
      arguments: ["--harness", other],
      environment: pi.environment,
    });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), setupMessage);
    assert.deepEqual(await savedHarness(pi.file), {
      name: "pi",
      kind: "file",
      path: other,
    });
  }));

await test("#819 native discovery and doctor still diagnose a factory-selected Pi 1.5.3", () =>
  withDoctor(async (scene) => {
    const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
    const result = initCli(scene, {
      arguments: ["--harness", pi.target],
      environment: pi.environment,
    });
    assert.equal(result.status, 7, result.stderr);
    const discovery = await probeHarness("pi", { env: pi.environment });
    assert.equal(discovery.entries[0]?.reason, "unsupported-version");
    const report = await scene.report(pi.environment);
    assert.match(
      String(check(report, "harnesses")["detail"]),
      /"name":"pi"[^}]*"working":false,"reason":"unsupported-version"/,
    );
    const selected = check(report, "default-harness");
    assert.equal(selected["result"], "fail");
    assert.match(String(selected["detail"]), /unsupported-version/);
  }));

const refusals = [
  { case: "missing", version: null, reason: "not-found" },
  {
    case: "shim",
    version: "Error: Pi 1.5.3 is unavailable",
    reason: "no-version",
  },
  { case: "malformed", version: "pi version 1.5.3", reason: "no-version" },
  { case: "partial", version: "1.5", reason: "no-version" },
] as const;

for (const refusal of refusals) {
  await test(`#819 factory setup keeps refusing a ${refusal.case} Pi executable`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, {
        kind: "file",
        version: refusal.version ?? "1.5.3",
      });
      const target =
        refusal.version === null
          ? join(scene.root, "missing", "pi")
          : pi.program;
      const result = initCli(scene, {
        arguments: ["--factory", "--harness", target],
        environment: pi.environment,
      });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        new RegExp(`harness-unusable: ${refusal.reason}`),
      );
      await assert.rejects(readFile(pi.file, "utf8"), { code: "ENOENT" });
    }));
}
