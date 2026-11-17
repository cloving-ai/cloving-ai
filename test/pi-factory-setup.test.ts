import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { probeHarness } from "../src/agent-harnesses.ts";
import { chooseHarness } from "../src/cli/init-selection.ts";
import { check, withDoctor } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";
import { terminalInit } from "./init-terminal-fixture.ts";
import {
  asked,
  outsidePi,
  probe,
  savedHarness,
  saveSelection,
  setupMessage,
  setupPi,
} from "./pi-factory-fixture.ts";

const kinds = ["file", "shell"] as const;

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
