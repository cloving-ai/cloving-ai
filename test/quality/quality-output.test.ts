import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { testMilliseconds } from "../test-timing.ts";
import { withFiles } from "./files-fixture.ts";
import {
  failingGate,
  moduleUrl,
  runtimeGate,
  shardGate,
} from "./gate-fixture.ts";

function shortCheck(check: string) {
  return { check, elapsedMilliseconds: 100, timeoutMilliseconds: 60000 };
}

for (const scenario of [
  {
    stage: "coverage",
    timings: [
      shortCheck("npm-inputs"),
      shortCheck("test-build"),
      {
        check: "tests",
        elapsedMilliseconds: 520000,
        timeoutMilliseconds: 600000,
      },
      shortCheck("coverage"),
    ],
    warnings: ["tests used 520 s of 600 s (87 percent)"],
    error: /Check exit 7/,
  },
  {
    stage: "tests",
    timings: [
      shortCheck("npm-inputs"),
      shortCheck("test-build"),
      { check: "tests", elapsedMilliseconds: 70, timeoutMilliseconds: 50 },
    ],
    warnings: ["tests used 0.07 s of 0.05 s (140 percent)"],
    error: /Check execution failed: tests \(limit 50 ms\)/,
  },
  {
    stage: "npm-inputs",
    timings: [shortCheck("npm-inputs")],
    warnings: [],
    error: /Check exit 7/,
  },
]) {
  await test(`CLV-152 prints collected timings when ${scenario.stage} fails`, async () => {
    await withFiles(await failingGate(scenario.stage), (directory) => {
      const result = spawnSync(process.execPath, ["tools/check-quality.ts"], {
        cwd: directory,
        env: { ...process.env, CLOVING_CHECK_TIME_FACTOR: "1" },
        encoding: "utf8",
        timeout: testMilliseconds(10_000),
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, scenario.error);
      assert.notEqual(result.stdout, "");
      const report: unknown = JSON.parse(result.stdout);
      assert.deepEqual(report, {
        timings: scenario.timings,
        warnings: scenario.warnings,
      });
      const warnings = scenario.warnings.map(
        (warning) => `Warning: ${warning}`,
      );
      assert.deepEqual(result.stderr.match(/^Warning:.*$/gm) ?? [], warnings);
      assert.ok(
        result.stderr.endsWith(
          warnings.map((warning) => `${warning}\n`).join(""),
        ),
      );
    });
  });
}

for (const [setting, options] of [
  [undefined, ["on", "coverage/shard"]],
  ["on", ["on", "coverage/shard"]],
  ["off", ["off", null]],
] as const)
  await test(`a shard takes its coverage from CLOVING_TEST_COVERAGE=${String(setting)}`, async () => {
    const result = await shardGate({
      CLOVING_TEST_SHARD: "2/2",
      CLOVING_TEST_COVERAGE: setting,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.recorded, options);
  });

await test("a shard refuses an unknown CLOVING_TEST_COVERAGE value, and the local gate ignores it", async () => {
  const shard = await shardGate({
    CLOVING_TEST_SHARD: "2/2",
    CLOVING_TEST_COVERAGE: "no",
  });
  assert.equal(shard.status, 1);
  assert.match(shard.stderr, /CLOVING_TEST_COVERAGE must be on or off/);
  assert.equal(shard.recorded, null);
  const local = await shardGate({ CLOVING_TEST_COVERAGE: "no" });
  assert.equal(local.status, 0, local.stderr);
});

for (const [setting, testSet] of [
  [undefined, "all"],
  ["all", "all"],
  ["platform", "platform"],
] as const)
  await test(`a shard takes its test set from CLOVING_TEST_SET=${String(setting)}`, async () => {
    const result = await shardGate({
      CLOVING_TEST_SHARD: "1/1",
      CLOVING_TEST_SET: setting,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.testSet, [testSet]);
  });

for (const [environment, message] of [
  [
    { CLOVING_TEST_SHARD: "2/2", CLOVING_TEST_SET: "full" },
    "CLOVING_TEST_SET must be all or platform",
  ],
  [
    { CLOVING_TEST_SET: "platform" },
    "CLOVING_TEST_SET=platform needs CLOVING_TEST_SHARD",
  ],
] as const)
  await test(`the gate refuses CLOVING_TEST_SET=${environment.CLOVING_TEST_SET} with ${String(environment.CLOVING_TEST_SHARD)} shard`, async () => {
    const result = await shardGate(environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(message));
    assert.equal(result.testSet, null);
  });

for (const shard of [undefined, "1/3"])
  await test(`the gate reads the changed paths of CLOVING_CHANGED_PATHS with ${String(shard)} shard`, async () => {
    await withFiles(
      {
        "changed-paths": "package.json\0src/cli/watch-view.ts\0",
        invalid: "/etc/hosts\0",
      },
      async (folder) => {
        const shardSetting =
          shard === undefined ? {} : { CLOVING_TEST_SHARD: shard };
        const changed = await shardGate({
          ...shardSetting,
          CLOVING_CHANGED_PATHS: join(folder, "changed-paths"),
        });
        assert.equal(changed.status, 0, changed.stderr);
        assert.deepEqual(changed.changedPaths, [
          "package.json",
          "src/cli/watch-view.ts",
        ]);
        const every = await shardGate({
          ...shardSetting,
          CLOVING_CHANGED_PATHS: undefined,
        });
        assert.equal(every.status, 0, every.stderr);
        assert.deepEqual(every.changedPaths, [null]);
        for (const [file, message] of [
          [
            "invalid",
            /CLOVING_CHANGED_PATHS must name a file of NUL-separated relative paths/,
          ],
          ["missing", /ENOENT/],
        ] as const) {
          const refused = await shardGate({
            ...shardSetting,
            CLOVING_CHANGED_PATHS: join(folder, file),
          });
          assert.equal(refused.status, 1);
          assert.match(refused.stderr, message);
          assert.equal(refused.changedPaths, null);
        }
      },
    );
  });

for (const shard of [undefined, "1/2", "2/2"]) {
  await test(`CLV-266 prepares runtime declarations before shard ${String(shard)} tests`, async () => {
    await withFiles(await runtimeGate(), (directory) => {
      const result = spawnSync(process.execPath, ["tools/check-quality.ts"], {
        cwd: directory,
        env: {
          ...process.env,
          CLOVING_CHECK_TIME_FACTOR: "1",
          CLOVING_TEST_SHARD: shard,
        },
        encoding: "utf8",
        timeout: testMilliseconds(10_000),
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const report: unknown = JSON.parse(result.stdout);
      assert.ok(report && typeof report === "object" && "timings" in report);
      assert.ok(Array.isArray(report.timings));
      const expected = shard === "2/2" ? [] : ["npm-inputs"];
      expected.push("test-build");
      if (shard === "1/2") expected.push("static-checks");
      assert.deepEqual(
        report.timings.map((timing: unknown) => {
          assert.ok(timing && typeof timing === "object" && "check" in timing);
          return timing.check;
        }),
        expected,
      );
    });
  });
}

for (const stage of ["success", "static-failure"]) {
  await test(`CLV-266 releases the static analysis process before shard tests: ${stage}`, async () => {
    const files = await runtimeGate();
    for (const name of await readdir("tools")) {
      if (name.startsWith("check-quality") && name.endsWith(".ts"))
        files[`tools/${name}`] = await readFile(`tools/${name}`, "utf8");
    }
    files["quality/project.ts"] = `
      import assert from "node:assert/strict";
      import { writeFileSync, readFileSync } from "node:fs";
      export { writeProjectReport, assertCheckCoverage, requiredChecks } from ${moduleUrl("quality/project.ts")};
      import { requiredChecks } from ${moduleUrl("quality/project.ts")};
      export async function checkProjectSources() {
        writeFileSync("source-owner", String(process.pid));
        if (${JSON.stringify(stage)} === "static-failure") throw new Error("static-analysis-failed");
        return { files: [], completed: requiredChecks.slice(0, -1), program: {} };
      }
      export async function checkProjectTestShard(directory, options) {
        const owner = Number(readFileSync("source-owner", "utf8"));
        assert.notEqual(owner, process.pid,
          "Static analysis must exit before shard tests start");
        assert.throws(() => process.kill(owner, 0), { code: "ESRCH" });
        writeFileSync("tests-ran", "yes");
        return { files: [], completed: ["tests"], timings: options.commandOptions.timings, warnings: [] };
      }
      export async function checkProject(directory, options) {
        await checkProjectSources();
        return await checkProjectTestShard(directory, options);
      }
    `;
    files["quality/production-inventory.ts"] =
      "export function productionInventory() { return []; }";
    await withFiles(files, async (directory) => {
      const result = spawnSync(process.execPath, ["tools/check-quality.ts"], {
        cwd: directory,
        env: { ...process.env, CLOVING_TEST_SHARD: "1/2" },
        encoding: "utf8",
        timeout: testMilliseconds(10_000),
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, stage === "success" ? 0 : 1, result.stderr);
      assert.equal(
        (await readdir(directory)).includes("tests-ran"),
        stage === "success",
      );
      assert.match(
        result.stderr,
        stage === "success" ? /^$/ : /static-analysis-failed/,
      );
    });
  });
}

await test("CLV-266 keeps a bounded analysis heap without inheriting Node options", async () => {
  const files = await runtimeGate();
  const command = moduleUrl("quality/command.ts");
  files["quality/command.ts"] = `
    export * from ${command};
    import assert from "node:assert/strict";
    import { runCommand as execute, runSupervisedCommand as supervise } from ${command};
    function bounded(command) {
      if (command.check === "static-checks")
        assert.ok(command.arguments.includes("--max-old-space-size=4096"), "Analysis child must retain the 4 GiB heap bound");
      return command;
    }
    export function runCommand(command, options) { return execute(bounded(command), options); }
    export async function runSupervisedCommand(command, options) { return await supervise(bounded(command), options); }
  `;
  await withFiles(files, (directory) => {
    const result = spawnSync(process.execPath, ["tools/check-quality.ts"], {
      cwd: directory,
      env: { ...process.env, CLOVING_TEST_SHARD: "1/2" },
      encoding: "utf8",
      timeout: testMilliseconds(10_000),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
});

async function stalledAnalysis(): Promise<Record<string, string>> {
  const files = await runtimeGate();
  const command = moduleUrl("quality/command.ts");
  files["quality/command.ts"] = `
    export * from ${command};
    import { runCommand as execute, runSupervisedCommand as supervise } from ${command};
    function bounded(command) {
      return { ...command, timeoutMilliseconds: command.check === "static-checks" ? 8000 : command.timeoutMilliseconds };
    }
    export function runCommand(command, options) { return execute(bounded(command), options); }
    export async function runSupervisedCommand(command, options) { return await supervise(bounded(command), options); }
  `;
  files["quality/project.ts"] = `
    export { writeProjectReport, assertCheckCoverage, checkProject, checkProjectTestShard } from ${moduleUrl("quality/project.ts")};
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    export async function checkProjectSources() {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync("analysis-descendant", String(child.pid));
      await new Promise(() => {});
    }
  `;
  return files;
}

function stopAnalysis(identifier: number): void {
  try {
    process.kill(identifier, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}

await test("CLV-266 a static timeout cleans up its analysis descendants", async () => {
  await withFiles(await stalledAnalysis(), async (directory) => {
    const result = spawnSync(process.execPath, ["tools/check-quality.ts"], {
      cwd: directory,
      env: { ...process.env, CLOVING_TEST_SHARD: "1/2" },
      encoding: "utf8",
      timeout: testMilliseconds(20_000),
    });
    const identifier = Number(
      await readFile(resolve(directory, "analysis-descendant"), "utf8"),
    );
    try {
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Check execution failed: static-checks/);
      assert.throws(() => process.kill(identifier, 0), { code: "ESRCH" });
    } finally {
      stopAnalysis(identifier);
    }
  });
});
