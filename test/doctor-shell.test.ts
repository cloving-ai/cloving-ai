import assert from "node:assert/strict";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { check, withDoctorWorkflow } from "./doctor-fixture.ts";

for (const scenario of [
  { launcher: "sh", options: [] },
  { launcher: "absolute", options: ["-e"] },
  { launcher: "sh", options: ["-o", "errexit"] },
  { launcher: "sh", options: ["-eo", "errexit"] },
  { launcher: "bash", options: ["-O", "extglob"] },
  { launcher: "zsh", options: ["-oerrexit"] },
  { launcher: "zsh", options: ["-ono_clobber"] },
  { launcher: "zsh", options: ["--emulate", "sh"] },
  { launcher: "zsh", options: ["-V"] },
])
  await test(`CLV-207 default harness preserves ${JSON.stringify(scenario)} wrapper arguments for its version probe`, () =>
    withDoctorWorkflow(async (scene) => {
      const script = join(scene.root, "claude wrapper.sh");
      await writeFile(
        script,
        'test "$#" -eq 1 && test "$1" = "--version" || exit 91\nprintf "2.1.1 (Claude Code)\\n"\n',
      );
      const shell = await scene.program(
        scenario.launcher === "absolute" ? "sh" : scenario.launcher,
        `import { execFileSync } from "node:child_process";
if (process.argv.at(-2) !== ${JSON.stringify(script)}) process.exit(2);
process.stdout.write(execFileSync(${JSON.stringify(scenario.launcher === "absolute" ? "/bin/sh" : `/bin/${scenario.launcher}`)}, process.argv.slice(2)));`,
      );
      const output = await scene.report({
        CLOVING_CLAUDE_COMMAND: JSON.stringify([
          scenario.launcher === "absolute" ? shell : scenario.launcher,
          ...scenario.options,
          script,
          "-p",
          "must not run a turn",
        ]),
      });
      assert.equal(check(output, "default-harness")["result"], "ok");
      assert.equal(output.status, 0);
    }));

await test("CLV-207 shell wrapper probes resolve relative scripts from the repository and retain failures", () =>
  withDoctorWorkflow(async (scene) => {
    const script = join(scene.repository, "-claude-wrapper.sh");
    const environment = {
      CLOVING_CLAUDE_COMMAND: '["/bin/sh","--","-claude-wrapper.sh"]',
    };
    await writeFile(
      script,
      'test "$#" -eq 1 && test "$1" = --version || exit 91\nprintf "2.1.1 (Claude Code)\\n"\n',
    );
    assert.equal(
      check(await scene.report(environment), "default-harness")["result"],
      "ok",
    );
    for (const body of ["exit 1", 'printf "no version\\n"']) {
      await writeFile(script, body);
      const failed = await scene.report(environment);
      assert.equal(check(failed, "harnesses")["result"], "ok");
      assert.equal(check(failed, "default-harness")["result"], "fail");
      assert.equal(failed.status, 1);
    }
  }));

await test("CLV-207 shell command strings cannot run a turn during a doctor probe", () =>
  withDoctorWorkflow(async (scene) => {
    const marker = join(scene.root, "turn-started");
    for (const arguments_ of [["-c"], ["--command"], []]) {
      const command = ["/bin/bash", ...arguments_];
      if (arguments_.length > 0) command.push(`printf turn > ${marker}`);
      const output = await scene.report({
        CLOVING_CLAUDE_COMMAND: JSON.stringify(command),
      });
      assert.equal(check(output, "default-harness")["result"], "fail");
    }
    await assert.rejects(access(marker), { code: "ENOENT" });
  }));

await test("CLV-207 shell wrapper probes use the repository for relative resources", () =>
  withDoctorWorkflow(async (scene) => {
    await writeFile(
      join(scene.repository, "version.txt"),
      "2.1.1 (Claude Code)\n",
    );
    await writeFile(
      join(scene.repository, "claude-wrapper.sh"),
      'test "$1" = --version || exit 91\nread -r version < ./version.txt || exit 92\nprintf "%s\\n" "$version"\n',
    );
    const output = await scene.report({
      CLOVING_CLAUDE_COMMAND: '["/bin/sh","./claude-wrapper.sh"]',
    });
    assert.equal(check(output, "default-harness")["result"], "ok");
    assert.equal(output.status, 0);
  }));

await test("CLV-207 a repository-relative executable harness reads repository resources", () =>
  withDoctorWorkflow(async (scene) => {
    const script = await scene.program(
      "repository-wrapper",
      'import { readFileSync } from "node:fs"; if (process.argv[2] !== "--version") process.exit(91); process.stdout.write(readFileSync("./version.txt", "utf8"));',
    );
    await rename(script, join(scene.repository, "claude-wrapper"));
    await writeFile(
      join(scene.repository, "version.txt"),
      "2.1.1 (Claude Code)\n",
    );
    const output = await scene.report({
      CLOVING_CLAUDE_COMMAND: '["./claude-wrapper"]',
    });
    assert.equal(check(output, "default-harness")["result"], "ok");
    assert.equal(output.status, 0);
  }));

await test("CLV-207 zsh emulation cannot substitute its own version for a failing wrapper", () =>
  withDoctorWorkflow(async (scene) => {
    const script = join(scene.root, "failing-wrapper.sh");
    await writeFile(script, "exit 91\n");
    const output = await scene.report({
      CLOVING_CLAUDE_COMMAND: JSON.stringify([
        "/bin/zsh",
        "--emulate",
        "sh",
        script,
      ]),
    });
    assert.equal(check(output, "harnesses")["result"], "ok");
    assert.equal(check(output, "default-harness")["result"], "fail");
    assert.equal(output.status, 1);
  }));

await test("CLV-207 shell terminal flags cannot substitute a launcher version for a wrapper probe", () =>
  withDoctorWorkflow(async (scene) => {
    const script = join(scene.root, "failing-wrapper.sh");
    await writeFile(script, "exit 91\n");
    for (const shell of ["/bin/bash", "/bin/zsh"])
      for (const option of ["--version", "--help"]) {
        const output = await scene.report({
          CLOVING_CLAUDE_COMMAND: JSON.stringify([shell, option, script]),
        });
        assert.equal(
          check(output, "default-harness")["result"],
          "fail",
          `${shell} ${option}`,
        );
        assert.equal(output.status, 1);
      }
  }));

for (const shell of ["sh", "bash"])
  await test(`CLV-207 ${shell} wrapper scripts can be readable files in the service PATH`, () =>
    withDoctorWorkflow(async (scene) => {
      await writeFile(
        join(scene.root, "bin/wrapper-in-path.sh"),
        'test "$1" = --version || exit 91\nprintf "2.1.1 (Claude Code)\\n"\n',
        { mode: 0o644 },
      );
      const output = await scene.report({
        CLOVING_CLAUDE_COMMAND: JSON.stringify([
          `/bin/${shell}`,
          "wrapper-in-path.sh",
        ]),
      });
      assert.equal(check(output, "default-harness")["result"], "ok");
      assert.equal(output.status, 0);
    }));

await test("CLV-207 zsh -b ends launcher options before a hyphen-leading script", () =>
  withDoctorWorkflow(async (scene) => {
    await writeFile(
      join(scene.repository, "-wrapper.sh"),
      'test "$1" = --version || exit 91\nprintf "2.1.1 (Claude Code)\\n"\n',
    );
    const output = await scene.report({
      CLOVING_CLAUDE_COMMAND: '["/bin/zsh","-b","-wrapper.sh"]',
    });
    assert.equal(check(output, "default-harness")["result"], "ok");
    assert.equal(output.status, 0);
  }));

for (const shell of ["sh", "bash"])
  await test(`CLV-207 ${shell} keeps a failing or unreadable repository wrapper ahead of PATH`, () =>
    withDoctorWorkflow(async (scene) => {
      await writeFile(
        join(scene.root, "bin/wrapper.sh"),
        'printf "2.1.1 (Claude Code)\\n"\n',
      );
      const local = join(scene.repository, "wrapper.sh");
      await writeFile(local, "exit 91\n");
      for (const mode of [0o644, 0o000]) {
        await chmod(local, mode);
        const output = await scene.report({
          CLOVING_CLAUDE_COMMAND: JSON.stringify([
            `/bin/${shell}`,
            "wrapper.sh",
          ]),
        });
        assert.equal(check(output, "default-harness")["result"], "fail");
        assert.equal(output.status, 1);
      }
    }));

await test("CLV-207 script lookup cannot borrow service cwd or add a zsh PATH fallback", () =>
  withDoctorWorkflow(async (scene) => {
    const body = 'printf "2.1.1 (Claude Code)\\n"\n';
    const runtime = runtimeDirectory(scene.environment, scene.repository);
    assert.ok(runtime);
    const project = join(dirname(runtime), "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "project-only.sh"), body);
    await writeFile(join(scene.root, "bin/path-only.sh"), body);
    for (const command of [
      ["/bin/sh", "project-only.sh"],
      ["/bin/zsh", "path-only.sh"],
    ]) {
      const output = await scene.report({
        CLOVING_CLAUDE_COMMAND: JSON.stringify(command),
      });
      assert.equal(check(output, "default-harness")["result"], "fail");
      assert.equal(output.status, 1);
    }
  }));
