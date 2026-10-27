import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, savedHarness, settings, withDoctor } from "./doctor-fixture.ts";

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

for (const [name, variable, version] of [
  ["claude", "CLOVING_CLAUDE_COMMAND", "2.1.1 (Claude Code)"],
  ["codex", "CLOVING_CODEX_COMMAND", "codex-cli 0.100.0"],
] as const)
  await test(`CLV-207 default harness probes configured ${name} outside PATH`, () =>
    withDoctor(async (scene) => {
      const configured = join(scene.root, name);
      await rename(
        await scene.program(
          "configured",
          `if (process.argv[2] !== "--version") process.exit(91); console.log(${JSON.stringify(version)})`,
        ),
        configured,
      );
      await scene.program("claude", "process.exit(1)");
      await scene.program("codex", "process.exit(1)");
      const output = await scene.report({
        CLOVING_WORKER: name,
        [variable]: JSON.stringify([configured]),
      });
      assert.equal(check(output, "harnesses")["result"], "fail");
      assert.equal(check(output, "default-harness")["result"], "ok");
      assert.ok(
        String(check(output, "default-harness")["detail"]).includes(configured),
      );
    }));

for (const body of ["process.exit(1)", 'console.log("no version")'])
  await test(`CLV-207 working bare harness cannot hide configured probe failure: ${body}`, () =>
    withDoctor(async (scene) => {
      const configured = await scene.program("configured", body);
      const output = await scene.report({
        CLOVING_CLAUDE_COMMAND: JSON.stringify([configured]),
      });
      assert.equal(check(output, "harnesses")["result"], "ok");
      assert.equal(check(output, "default-harness")["result"], "fail");
      assert.equal(output.status, 1);
    }));

await test("CLV-207 Node wrappers cannot substitute the launcher version for a missing or failing worker", () =>
  withDoctor(async (scene) => {
    const command = {
      CLOVING_CLAUDE_COMMAND: JSON.stringify([
        process.execPath,
        "worker.mjs",
        "-p",
        "must not run a turn",
      ]),
    };
    for (const body of [
      undefined,
      "process.exit(91)",
      'console.log("no version")',
    ]) {
      if (body !== undefined)
        await writeFile(join(scene.repository, "worker.mjs"), body);
      const output = await scene.report(command);
      assert.equal(check(output, "harnesses")["result"], "ok");
      assert.equal(check(output, "default-harness")["result"], "fail");
      assert.equal(output.status, 1);
    }
  }));

await test("CLV-207 Node wrapper probes keep the repository script and replace turn arguments with --version", () =>
  withDoctor(async (scene) => {
    await writeFile(
      join(scene.repository, "version.txt"),
      "2.1.1 (Claude Code)\n",
    );
    await writeFile(
      join(scene.repository, "worker.mjs"),
      'import assert from "node:assert/strict"; import { readFileSync, writeFileSync } from "node:fs"; assert.deepEqual(process.argv.slice(2), ["--version"]); writeFileSync(process.env.DOCTOR_PROBE_MARKER, "probed"); process.stdout.write(readFileSync("./version.txt", "utf8"));',
    );
    for (const prefix of [[], ["--"]]) {
      const marker = join(scene.root, `node-probe-${String(prefix.length)}`);
      const output = await scene.report({
        DOCTOR_PROBE_MARKER: marker,
        CLOVING_CLAUDE_COMMAND: JSON.stringify([
          process.execPath,
          ...prefix,
          "worker.mjs",
          "-p",
          "must not run a turn",
        ]),
      });
      assert.equal(check(output, "default-harness")["result"], "ok");
      assert.equal(output.status, 0);
      assert.equal(await readFile(marker, "utf8"), "probed");
    }
  }));

await test("CLV-207 unsupported launcher arguments cannot run a turn or pass on a launcher version", () =>
  withDoctor(async (scene) => {
    const marker = join(scene.root, "turn-started");
    const launcher = await scene.program(
      "unsupported-launcher",
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "called"); console.log("9.9.9");`,
    );
    for (const command of [
      [launcher, "worker.mjs"],
      [process.execPath],
      [process.execPath, "--version", "missing-worker.mjs"],
      [process.execPath, "-e", `throw new Error("must not execute")`],
    ]) {
      const output = await scene.report({
        CLOVING_CLAUDE_COMMAND: JSON.stringify(command),
      });
      assert.equal(check(output, "default-harness")["result"], "fail");
      assert.equal(output.status, 1);
    }
    await assert.rejects(access(marker), { code: "ENOENT" });
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
      JSON.stringify({ version: 1, harness: { name: 7 } }),
    );
    const privateCheck = check(await scene.report(), "settings-files");
    assert.equal(privateCheck["result"], "fail");
    assert.equal(privateCheck["detail"], "invalid-setting: harness.name");
    const projectFile = join(scene.repository, ".cloving/config.json");
    for (const file of [privateFile, projectFile])
      assert.ok(String(privateCheck["fix"]).includes(file));
    await writeFile(privateFile, '{"version":1}');
    await settings(scene, {
      version: 1,
      privateTexts: ["not allowed in project"],
    });
    const projectCheck = check(await scene.report(), "settings-files");
    assert.equal(projectCheck["result"], "fail");
    assert.equal(
      projectCheck["detail"],
      "private-setting-in-project-file: privateTexts",
    );
    for (const file of [privateFile, projectFile])
      assert.ok(String(projectCheck["fix"]).includes(file));
  }));

await test("CLV-207 default-harness probes the saved harness path outside the search path", () =>
  withDoctor(async (scene) => {
    const saved = join(scene.root, "installed", "claude");
    await mkdir(dirname(saved), { recursive: true });
    await rename(join(scene.root, "bin", "claude"), saved);
    await savedHarness(scene, { kind: "file", path: saved });
    const output = await scene.report();
    assert.equal(check(output, "default-harness")["result"], "ok");
  }));

await test("CLV-207 a working bare claude does not hide a broken saved harness path", () =>
  withDoctor(async (scene) => {
    await savedHarness(scene, {
      kind: "file",
      path: join(scene.root, "missing", "claude"),
    });
    const output = await scene.report();
    assert.equal(check(output, "default-harness")["result"], "fail");
  }));

const workingGrok =
  'if (process.argv[2] !== "--version") process.exit(91); console.log("1.4.0")';

await test("CLV-207 default-harness probes a working Grok worker with its default arguments", () =>
  withDoctor(async (scene) => {
    await scene.program("grok", workingGrok);
    const selected = check(
      await scene.report({ CLOVING_WORKER: "grok" }),
      "default-harness",
    );
    assert.equal(selected["result"], "ok", String(selected["detail"]));
  }));

await test("CLV-207 a working bare grok does not hide a broken CLOVING_GROK_COMMAND", () =>
  withDoctor(async (scene) => {
    await scene.program("grok", workingGrok);
    const selected = check(
      await scene.report({
        CLOVING_WORKER: "grok",
        CLOVING_GROK_COMMAND: JSON.stringify([
          join(scene.root, "missing", "grok"),
        ]),
      }),
      "default-harness",
    );
    assert.equal(selected["result"], "fail", String(selected["detail"]));
  }));
