import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      export { writeProjectReport } from ${project};
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
      export { writeProjectReport } from ${moduleUrl("quality/project.ts")};
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
