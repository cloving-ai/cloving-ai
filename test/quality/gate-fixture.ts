import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { testMilliseconds } from "../test-timing.ts";
import { withFiles } from "./files-fixture.ts";

export function moduleUrl(file: string): string {
  return JSON.stringify(pathToFileURL(resolve(file)).href);
}

export async function failingGate(
  stage: string,
): Promise<Record<string, string>> {
  const command = moduleUrl("quality/command.ts");
  const project = moduleUrl("quality/project.ts");
  return {
    "package.json": JSON.stringify({
      type: "module",
      scripts: { build: "node -e 0" },
    }),
    "tools/check-quality.ts": await readFile("tools/check-quality.ts", "utf8"),
    "quality/command.ts": `
      export * from ${command};
      import { runCommand as execute } from ${command};
      export function runCommand(command, options) {
        let tick = 0;
        return execute(command, command.check === "test-build"
          ? { ...options, clock: () => { tick += 100; return tick; } }
          : options);
      }
    `,
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

export async function runtimeGate(): Promise<Record<string, string>> {
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
        assert.equal(existsSync("dist/src/main.d.ts"), true);
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
        const { writeFileSync } = await import("node:fs");
        writeFileSync("coverage-options.json", JSON.stringify([options.coverage ?? null, options.coverageDirectory ?? null]));
        writeFileSync("test-set.json", JSON.stringify([options.testSet ?? null]));
        return { files: [], completed: ["tests"], timings: options.commandOptions.timings, warnings: [] };
      }
      export async function checkProject(directory, options) {
        return { timings: options.commandOptions.timings, warnings: [] };
      }
    `,
  };
}

function recordedOptions(text: string): readonly (string | null)[] {
  const value: unknown = JSON.parse(text);
  assert.ok(Array.isArray(value));
  return value.map((item: unknown) => (typeof item === "string" ? item : null));
}

export async function shardGate(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return await withFiles(await runtimeGate(), async (directory) => {
    const result = spawnSync(process.execPath, ["tools/check-quality.ts"], {
      cwd: directory,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      timeout: testMilliseconds(10_000),
    });
    const read = async (name: string) =>
      await readFile(resolve(directory, name), "utf8").then(
        recordedOptions,
        () => null,
      );
    return {
      status: result.status,
      stderr: result.stderr,
      recorded: await read("coverage-options.json"),
      testSet: await read("test-set.json"),
    };
  });
}
