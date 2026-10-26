import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, settings, withDoctor } from "./doctor-fixture.ts";

const codes = [
  "git-repository",
  "node-version",
  "harnesses",
  "default-harness",
  "gh-login",
  "github-origin",
  "greptile-review",
  "settings-files",
  "runtime-directory",
  "service",
  "ticket-command",
  "next-command",
  "check-command",
  "queue-interval",
  "private-texts",
];

await test("CLV-207 doctor emits the ordered versioned report and local successes", () =>
  withDoctor(async (scene) => {
    const output = await scene.report();
    assert.equal(output.version, 1);
    assert.equal(
      check(output, "node-version")["result"],
      process.version === "v26.9.0" ? "ok" : "fail",
    );
    assert.deepEqual(
      output.checks.map((item) => item["code"]),
      codes,
    );
    for (const code of [
      "git-repository",
      "harnesses",
      "default-harness",
      "settings-files",
      "ticket-command",
      "next-command",
      "check-command",
      "queue-interval",
      "private-texts",
    ]) {
      const item = check(output, code);
      assert.equal(item["result"], "ok", code);
      assert.equal(typeof item["required"], "boolean");
      assert.equal(typeof item["detail"], "string");
      assert.equal(typeof item["fix"], "string");
    }
    assert.match(
      String(check(output, "git-repository")["detail"]),
      /branch main/,
    );
  }));

await test("CLV-207 invalid settings fail first and skip setting dependent probes", () =>
  withDoctor(async (scene) => {
    await settings(scene, { version: 7 });
    const output = await scene.report();
    assert.equal(check(output, "settings-files")["result"], "fail");
    for (const code of [
      "default-harness",
      "gh-login",
      "ticket-command",
      "next-command",
      "check-command",
      "queue-interval",
      "private-texts",
    ])
      assert.equal(check(output, code)["result"], "skip", code);
    assert.equal(output.status, 1);
  }));

await test("CLV-207 default harness follows environment over the private file", () =>
  withDoctor(async (scene) => {
    const privateFile = privateSettingsPath(
      scene.environment,
      scene.repository,
    );
    await mkdir(join(scene.root, "config/cloving/projects"), {
      recursive: true,
    });
    await writeFile(
      privateFile,
      JSON.stringify({ version: 1, harness: { name: "claude" } }),
    );
    const output = await scene.report({ CLOVING_WORKER: "codex" });
    assert.equal(check(output, "default-harness")["result"], "ok");
    assert.match(String(check(output, "default-harness")["detail"]), /codex/);
    const failed = await scene.report({
      CLOVING_CLAUDE_COMMAND: '["missing-program"]',
    });
    assert.equal(check(failed, "harnesses")["result"], "ok");
    assert.equal(check(failed, "default-harness")["result"], "fail");
  }));

await test("CLV-207 no usable harness fails both harness checks without running a turn", () =>
  withDoctor(async (scene) => {
    await scene.program("claude", "process.exit(1)");
    await scene.program("codex", "process.exit(1)");
    const output = await scene.report();
    assert.equal(check(output, "harnesses")["result"], "fail");
    assert.equal(check(output, "default-harness")["result"], "fail");
  }));

for (const [code, variable] of [
  ["ticket-command", "CLOVING_TICKET_COMMAND"],
  ["next-command", "CLOVING_NEXT_COMMAND"],
  ["check-command", "CLOVING_CHECK_COMMAND"],
] as const)
  await test(`CLV-207 ${code} fails absent, empty, missing and non executable programs`, () =>
    withDoctor(async (scene) => {
      const path = await scene.program("configured", "process.exit(91)");
      await chmod(path, 0o644);
      for (const value of [
        undefined,
        "[]",
        '["missing-program"]',
        JSON.stringify([path]),
      ]) {
        const output = await scene.report({ [variable]: value });
        assert.equal(check(output, code)["result"], "fail", String(value));
      }
    }));

await test("CLV-207 relative ticket and next commands resolve from the generated project", () =>
  withDoctor(async (scene) => {
    const path = join(scene.repository, "ticket");
    await writeFile(path, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const output = await scene.report({
      CLOVING_TICKET_COMMAND: '["./ticket"]',
      CLOVING_NEXT_COMMAND: '["./ticket"]',
      CLOVING_CHECK_COMMAND: '["./ticket"]',
    });
    assert.equal(check(output, "ticket-command")["result"], "fail");
    assert.equal(check(output, "next-command")["result"], "fail");
    assert.equal(check(output, "check-command")["result"], "ok");
  }));

await test("CLV-207 invalid or missing queue intervals and blank private texts fail", () =>
  withDoctor(async (scene) => {
    for (const value of [undefined, "9", "3601", "10.5", "no"]) {
      const output = await scene.report({
        CLOVING_QUEUE_SECONDS: value,
        CLOVING_PRIVATE_TEXTS: '[" "]',
      });
      assert.equal(check(output, "queue-interval")["result"], "fail");
      assert.equal(check(output, "private-texts")["result"], "fail");
    }
  }));

await test("CLV-207 settings repairs name both concrete files when schema errors lack a scope", () =>
  withDoctor(async (scene) => {
    const privateFile = privateSettingsPath(
      scene.environment,
      scene.repository,
    );
    await mkdir(join(scene.root, "config/cloving/projects"), {
      recursive: true,
    });
    await writeFile(
      privateFile,
      JSON.stringify({ version: 1, harness: { name: "missing-harness" } }),
    );
    assert.ok(
      String(check(await scene.report(), "settings-files")["fix"]).includes(
        privateFile,
      ),
    );
    await writeFile(privateFile, '{"version":1}');
    await settings(scene, {
      version: 1,
      privateTexts: ["not allowed in project"],
    });
    assert.ok(
      String(check(await scene.report(), "settings-files")["fix"]).includes(
        join(scene.repository, ".cloving/config.json"),
      ),
    );
  }));
