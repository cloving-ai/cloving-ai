import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { testMilliseconds } from "../test-timing.ts";
import { withFiles } from "./files-fixture.ts";

function moduleUrl(file: string): string {
  return JSON.stringify(pathToFileURL(resolve(file)).href);
}

async function failingGate(stage: string): Promise<Record<string, string>> {
  const command = moduleUrl("quality/command.ts");
  const project = moduleUrl("quality/project.ts");
  return {
    "package.json": '{"type":"module"}',
    "tools/check-quality.ts": await readFile("tools/check-quality.ts", "utf8"),
    "quality/command.ts": `export * from ${command};`,
    "quality/test-execution.ts": `export { parseCheckTimeFactor } from ${moduleUrl("quality/test-execution.ts")};`,
    "quality/generated-output.ts":
      "export async function inspectGenerated() { return { outputs: {} }; }",
    "quality/module-policy.ts":
      "export function proposedModulePolicy() { return {}; }",
    "quality/product-steps.ts":
      "export async function productStepExports() { return {}; }",
    "quality/npm-inputs.ts": `
      import { runCommand } from ${command};
      export async function checkNpmInputs(directory, options) {
        let tick = 0;
        runCommand({ check: "npm-inputs", executable: process.execPath,
          arguments: ["-e", ${JSON.stringify(stage === "npm-inputs" ? "process.exitCode = 7" : "")}],
          directory, timeoutMilliseconds: 60000 },
          { ...options, clock: () => { tick += 100; return tick; } });
      }
    `,
    "quality/project.ts": `
      export { writeProjectReport, assertCheckCoverage } from ${project};
      export { checkProjectTestShard } from ${project};
      import { runCommand } from ${command};
      export async function checkProject(directory, options) {
        const timeout = ${JSON.stringify(stage === "tests")};
        let tick = 0;
        runCommand({ check: "tests", executable: process.execPath,
          arguments: ["-e", timeout ? "setInterval(() => {}, 1000)" : ""],
          directory, timeoutMilliseconds: timeout ? 50 : 600000 },
          { ...options.commandOptions,
            clock: () => { tick += timeout ? 70 : 520000; return tick; } });
        runCommand({ check: "coverage", executable: process.execPath,
          arguments: ["-e", "process.exitCode = 7"],
          directory, timeoutMilliseconds: 60000 },
          { ...options.commandOptions,
            clock: () => { tick += 100; return tick; } });
      }
    `,
  };
}

for (const scenario of [
  {
    stage: "coverage",
    timings: [
      {
        check: "npm-inputs",
        elapsedMilliseconds: 100,
        timeoutMilliseconds: 60000,
      },
      {
        check: "tests",
        elapsedMilliseconds: 520000,
        timeoutMilliseconds: 600000,
      },
      {
        check: "coverage",
        elapsedMilliseconds: 100,
        timeoutMilliseconds: 60000,
      },
    ],
    warnings: ["tests used 520 s of 600 s (87 percent)"],
    error: /Check exit 7/,
  },
  {
    stage: "tests",
    timings: [
      {
        check: "npm-inputs",
        elapsedMilliseconds: 100,
        timeoutMilliseconds: 60000,
      },
      { check: "tests", elapsedMilliseconds: 70, timeoutMilliseconds: 50 },
    ],
    warnings: ["tests used 0.07 s of 0.05 s (140 percent)"],
    error: /Check execution failed: tests \(limit 50 ms\)/,
  },
  {
    stage: "npm-inputs",
    timings: [
      {
        check: "npm-inputs",
        elapsedMilliseconds: 100,
        timeoutMilliseconds: 60000,
      },
    ],
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

async function runtimeGate(
  shard: string | undefined,
): Promise<Record<string, string>> {
  return {
    ...(await failingGate("coverage")),
    "tools/check-quality-sources.ts": await readFile(
      "tools/check-quality-sources.ts",
      "utf8",
    ),
    "quality/production-inventory.ts":
      "export function productionInventory() { return []; }",
    "package.json": JSON.stringify({
      type: "module",
      scripts: { build: "node build.mjs" },
    }),
    "build.mjs": `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync("dist/src", { recursive: true });
      writeFileSync("dist/src/main.d.ts", "export declare const value: number;");
    `,
    "quality/generated-output.ts": `
      import assert from "node:assert/strict";
      import { existsSync } from "node:fs";
      export async function inspectGenerated() {
        assert.equal(existsSync("dist/src/main.d.ts"), ${String(shard !== undefined)});
        return { outputs: {} };
      }
    `,
    "quality/project.ts": `
      export { writeProjectReport, assertCheckCoverage } from ${moduleUrl("quality/project.ts")};
      import { requiredChecks } from ${moduleUrl("quality/project.ts")};
      export async function checkProjectSources() {
        return { program: {}, files: [], completed: requiredChecks.slice(0, -1) };
      }
      export async function checkProjectTestShard(directory, options) {
        return { files: [], completed: ["tests"], timings: options.commandOptions.timings, warnings: [] };
      }
      export async function checkProject(directory, options) {
        return { timings: options.commandOptions.timings, warnings: [] };
      }
    `,
  };
}

for (const shard of [undefined, "1/2", "2/2"]) {
  await test(`CLV-266 prepares runtime declarations before shard ${String(shard)} tests`, async () => {
    await withFiles(await runtimeGate(shard), (directory) => {
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
      if (shard !== undefined) expected.push("test-build");
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
    const files = await runtimeGate("1/2");
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
  const files = await runtimeGate("1/2");
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
  const files = await runtimeGate("1/2");
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
