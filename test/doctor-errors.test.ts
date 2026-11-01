import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { doctorReport } from "../src/cli/doctor.ts";
import { runtimeObservation } from "../src/cli/doctor-runtime.ts";
import { doctorWorkflows } from "../src/cli/doctor-workflows.ts";
import {
  adoptionRecordPath,
  runtimeDirectory,
} from "../src/cli/runtime-directory.ts";
import { createProbeRunner } from "../src/cli/probe-command.ts";
import { check, withDoctor } from "./doctor-fixture.ts";

const probe = createProbeRunner({
  spawn: (input) => spawn(input.executable, input.arguments, input.options),
  kill: (identifier, signal) => process.kill(identifier, signal),
});

await test("CLV-207 detached git repositories retain a usable diagnostic", () =>
  withDoctor(async (scene) => {
    execFileSync("git", [
      "-C",
      scene.repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    execFileSync("git", ["-C", scene.repository, "checkout", "--detach", "-q"]);
    assert.equal(check(await scene.report(), "git-repository")["result"], "ok");
    const report = await doctorReport({
      repository: scene.repository,
      environment: scene.environment,
      probe: (program, options) =>
        program === "git"
          ? Promise.resolve({ stdout: "", reason: "probe-exit" })
          : probe(program, options),
    });
    assert.equal(
      report.checks.find((item) => item.code === "git-repository")?.result,
      "fail",
    );
  }));

await test("CLV-207 absent GitHub origins and unusable configured commands fail", () =>
  withDoctor(async (scene) => {
    execFileSync("git", ["-C", scene.repository, "remote", "remove", "origin"]);
    assert.equal(
      check(await scene.report(), "github-origin")["result"],
      "fail",
    );
    for (const command of ["[]", "not JSON", '["missing-gh"]'])
      assert.equal(
        check(await scene.report({ CLOVING_GH_COMMAND: command }), "gh-login")[
          "result"
        ],
        "fail",
      );
  }));

for (const payload of [
  "not JSON",
  "{}",
  "[{}]",
  '[{"number":1.5}]',
  '[{"number":0}]',
])
  await test(`CLV-207 malformed pull request response ${payload} fails closed`, () =>
    withDoctor(async (scene) => {
      await scene.program(
        "gh",
        `if (process.argv[2] === "auth") process.exit(0); console.log(${JSON.stringify(payload)});`,
      );
      assert.equal(
        check(await scene.report(), "greptile-review")["result"],
        "fail",
      );
    }));

await test("CLV-207 paginated inline bot comments count while human and malformed comments do not", () =>
  withDoctor(async (scene) => {
    await scene.program(
      "gh",
      `
if (process.argv[2] === "auth") process.exit(0);
if (process.argv[2] === "pr") console.log('[{"number":1}]');
else console.log(process.argv.at(-1).includes("pulls/1/comments") ? '[[{"user":{"login":"greptile-apps[bot]"}}]]' : '[{}, {"user":null}, {"user":{"login":"human"}}]');
`,
    );
    assert.equal(
      check(await scene.report(), "greptile-review")["result"],
      "ok",
    );
    await scene.program(
      "gh",
      'if (process.argv[2] === "auth") process.exit(0); console.log(process.argv[2] === "pr" ? "[{\\"number\\":1}]" : "{}")',
    );
    assert.equal(
      check(await scene.report(), "greptile-review")["result"],
      "fail",
    );
  }));

await test("CLV-207 malformed adoption records skip checks that need the generated project", () =>
  withDoctor(async (scene) => {
    const record = adoptionRecordPath(scene.environment, scene.repository);
    assert.ok(record);
    await mkdir(dirname(record), { recursive: true });
    await writeFile(record, "{}");
    const output = await scene.report();
    assert.equal(check(output, "runtime-directory")["result"], "fail");
    assert.equal(check(output, "default-harness")["result"], "ok");
    for (const code of ["ticket-command", "next-command", "service"])
      assert.equal(check(output, code)["result"], "skip");
  }));

await test("CLV-207 missing runtime configuration and failed adoption reads remain failed observations", () =>
  withDoctor(async (scene) => {
    const missing = await runtimeObservation(scene.repository, {
      environment: {},
      probe,
    });
    assert.equal(missing.observation.result, "fail");
    for (const output of [
      { stdout: "", reason: "probe-start" },
      { stdout: "not JSON", reason: null },
      { stdout: "{}", reason: null },
    ]) {
      const result = await runtimeObservation(scene.repository, {
        environment: scene.environment,
        probe: () => Promise.resolve(output),
      });
      assert.equal(result.observation.result, "fail");
    }
  }));

await test("CLV-207 non-directory runtimes and start folders fail; stale endpoints fail service", () =>
  withDoctor(async (scene) => {
    const file = join(scene.root, "file-runtime");
    await writeFile(file, "");
    assert.equal(
      check(
        await scene.report({ CLOVING_RUNTIME_DIR: file }),
        "runtime-directory",
      )["result"],
      "fail",
    );
    const runtime = runtimeDirectory(scene.environment, scene.repository);
    assert.ok(runtime);
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const project = join(dirname(runtime), "project");
    await writeFile(project, "");
    assert.equal(
      check(await scene.report(), "runtime-directory")["result"],
      "fail",
    );
    const alternate = join(scene.root, "alternate/run");
    await mkdir(alternate, { recursive: true, mode: 0o700 });
    await mkdir(join(dirname(alternate), "project"));
    await writeFile(join(alternate, "control.sock"), "");
    assert.equal(
      check(await scene.report({ CLOVING_RUNTIME_DIR: alternate }), "service")[
        "result"
      ],
      "fail",
    );
  }));

await test("CLV-207 workflow discovery ignores incomplete and invalid files without importing them", () =>
  withDoctor(async (scene) => {
    const folder = join(scene.repository, ".cloving/workflows");
    await mkdir(folder, { recursive: true });
    for (const name of [
      "missing.ts",
      "invalid.ts",
      "malformed.ts",
      "ignored.d.ts",
      "ignored.test.ts",
      "readme.txt",
    ])
      await writeFile(join(folder, name), 'throw new Error("must not import")');
    await writeFile(join(folder, "invalid.declaration.json"), "{}");
    await writeFile(join(folder, "malformed.declaration.json"), "not JSON");
    const found = await doctorWorkflows(scene.repository, scene.environment);
    assert.deepEqual(found, []);
    await assert.rejects(
      doctorWorkflows(scene.repository, {
        XDG_CONFIG_HOME: join(scene.repository, "file"),
        HOME: scene.root,
      }),
      { code: "ENOTDIR" },
    );
  }));

await test("CLV-207 inaccessible settings locations still produce a versioned report and prerequisite skips", () =>
  withDoctor(async (scene) => {
    const output = await scene.report({
      XDG_CONFIG_HOME: join(scene.repository, "file"),
    });
    assert.equal(output.version, 1);
    assert.equal(check(output, "settings-files")["result"], "fail");
    for (const code of [
      "default-harness",
      "no-workflow",
      "gh-login",
      "github-origin",
      "ticket-command",
      "next-command",
      "check-command",
      "queue-interval",
      "private-texts",
    ])
      assert.equal(check(output, code)["result"], "skip", code);
  }));

await test("CLV-207 unavailable workflow discovery skips dependent checks without hiding valid settings", () =>
  withDoctor(async (scene) => {
    await mkdir(join(scene.repository, ".cloving"));
    await writeFile(
      join(scene.repository, ".cloving/workflows"),
      "not a folder",
    );
    const output = await scene.report();
    assert.equal(check(output, "settings-files")["result"], "ok");
    assert.equal(check(output, "default-harness")["result"], "ok");
    assert.equal(check(output, "runtime-directory")["result"], "ok");
    for (const code of [
      "no-workflow",
      "gh-login",
      "github-origin",
      "ticket-command",
      "check-command",
      "private-texts",
    ])
      assert.equal(check(output, code)["result"], "skip", code);
    assert.match(
      String(check(output, "ticket-command")["detail"]),
      /workflow.*unavailable/i,
    );
    assert.equal(output.status, 1);
  }));
