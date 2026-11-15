import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { record } from "../src/protocol.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { eventually, runCli } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

await test("CLV-347 fresh separate-root analyzers invalidate cached facts when only their own package exports change", () =>
  withFiles({}, async (root) => {
    const analyzer = join(root, "analyzer");
    for (const name of ["src", "tools", "dist", "package.json"])
      await cp(join(candidatePackageRoot, name), join(analyzer, name), {
        recursive: true,
      });
    await symlink(
      join(candidatePackageRoot, "node_modules"),
      join(analyzer, "node_modules"),
    );
    const driver = join(root, "analyze.mjs");
    await writeFile(
      driver,
      `import { admitWorkflowCandidate } from ${JSON.stringify(pathToFileURL(join(analyzer, "tools/admit-workflow.ts")).href)};
const options = { packageRoot: ${JSON.stringify(candidatePackageRoot)}, ...(process.argv[2] === "cached" ? { cacheDirectory: ${JSON.stringify(join(root, "cache"))} } : {}) };
process.stdout.write(JSON.stringify(await admitWorkflowCandidate(${JSON.stringify({ source: validCandidateSource, declaration: candidateDeclaration })}, options)));`,
    );
    const analyze = (mode: string) => {
      const result = spawnSync(process.execPath, [driver, mode], {
        encoding: "utf8",
        timeout: testMilliseconds(30_000),
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return record(JSON.parse(result.stdout));
    };
    assert.equal(analyze("cached")?.["kind"], "admitted");
    const file = join(analyzer, "package.json");
    const metadata = record(JSON.parse(await readFile(file, "utf8")));
    const exports = record(metadata?.["exports"]);
    assert.ok(metadata && exports);
    assert.ok(Object.hasOwn(exports, "./workflows/steps/protected-effect"));
    await writeFile(
      file,
      JSON.stringify({
        ...metadata,
        exports: Object.fromEntries(
          Object.entries(exports).filter(
            ([name]) => name !== "./workflows/steps/protected-effect",
          ),
        ),
      }),
    );
    const fresh = analyze("fresh");
    assert.equal(fresh?.["kind"], "refused");
    assert.deepEqual(analyze("cached"), fresh);
  }));

await test("CLV-347 an unreadable initial producer context disables reuse and still uses the actual compiler for each admission", () =>
  withFiles({}, async (root) => {
    const preload = join(root, "unreadable.mjs");
    await writeFile(
      preload,
      `import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const original = filesystem.readFile.bind(filesystem);
let refused = false;
filesystem.readFile = (...parameters) => {
  if (!refused && String(parameters[0]) === ${JSON.stringify(resolve(import.meta.dirname, "../package.json"))}) {
    refused = true;
    throw new Error("initial-producer-context-unreadable");
  }
  return original(...parameters);
};
syncBuiltinESMExports();`,
    );
    const driver = join(root, "admit.mjs");
    const input = {
      source: validCandidateSource,
      declaration: candidateDeclaration,
    };
    await writeFile(
      driver,
      `import { admitWorkflowCandidate } from ${JSON.stringify(new URL("../tools/admit-workflow.ts", import.meta.url).href)};
const input = ${JSON.stringify(input)};
const options = ${JSON.stringify({ packageRoot: candidatePackageRoot, cacheDirectory: join(root, "cache") })};
console.log(JSON.stringify([await admitWorkflowCandidate(input, options), await admitWorkflowCandidate(input, options)]));`,
    );
    const result = spawnSync(process.execPath, ["--import", preload, driver], {
      encoding: "utf8",
      timeout: testMilliseconds(30_000),
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        CLOVING_RESTART_TRACE: "1",
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const values: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(values));
    assert.equal(values.length, 2);
    assert.equal(record(values[0])?.["kind"], "admitted");
    assert.deepEqual(values[0], values[1]);
    assert.equal(result.stderr.includes("analysis-cache-hit"), false);
    assert.equal(result.stderr.match(/candidate-compiler-start/g)?.length, 2);
  }));

async function rebuiltAnalyzer(root: string): Promise<string> {
  const analyzer = join(root, "analyzer");
  for (const name of [
    "src",
    "tools",
    "dist",
    "package.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ])
    await cp(join(candidatePackageRoot, name), join(analyzer, name), {
      recursive: true,
    });
  await symlink(
    join(candidatePackageRoot, "node_modules"),
    join(analyzer, "node_modules"),
  );
  return analyzer;
}

async function stricterAnalyzer(analyzer: string): Promise<void> {
  const path = join(analyzer, "tools/workflow-candidate-source.ts");
  const source = await readFile(path, "utf8");
  const before =
    "  return analyzeProgram(\n    candidateProgram(text, installed),";
  assert.ok(source.includes(before));
  await writeFile(
    path,
    source.replace(
      before,
      '  if (text.includes("epoch-probe")) return { analysis: { imports: [], effects: [], directEffects: ["epoch-rule"], unsupportedForms: [], knownCallCount: 0, knownUnitTotal: 0 }, installedExports: {} };\n' +
        before,
    ),
  );
  execFileSync(
    process.execPath,
    [
      join(analyzer, "node_modules/typescript/bin/tsc"),
      "--project",
      "tsconfig.build.json",
    ],
    {
      cwd: analyzer,
      timeout: 60_000,
      stdio: "pipe",
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
    },
  );
}

async function epochClient(root: string, analyzer: string): Promise<string> {
  const driver = join(root, "epoch.mjs");
  const input = {
    source: validCandidateSource.replaceAll('"synthetic"', '"epoch-probe"'),
    declaration: candidateDeclaration,
  };
  await writeFile(
    driver,
    `import { admitWorkflowCandidate } from ${JSON.stringify(pathToFileURL(join(analyzer, "dist/tools/admit-workflow.js")).href)};
import { existsSync, writeFileSync } from "node:fs";
if (process.argv[2] === "loaded") {
writeFileSync(new URL("./analyzer-loaded", import.meta.url), "ready");
await new Promise((resolve) => { const timer = setInterval(() => { if (existsSync(new URL("./analyze-now", import.meta.url))) { clearInterval(timer); resolve(); } }, 10); });
}
const options = { packageRoot: ${JSON.stringify(candidatePackageRoot)}, ...(process.argv[2] === "fresh" ? {} : { cacheDirectory: ${JSON.stringify(join(root, "cache"))} }) };
process.stdout.write(JSON.stringify(await admitWorkflowCandidate(${JSON.stringify(input)}, options)));`,
  );
  return driver;
}

await test("CLV-347 an already loaded analyzer cannot publish old facts under a rebuilt analyzer's context", () =>
  withFiles({}, async (root) => {
    const analyzer = await rebuiltAnalyzer(root);
    const driver = await epochClient(root, analyzer);
    const controller = new AbortController();
    const loaded = runCli(["loaded"], {
      directory: root,
      runtime: root,
      entryPoint: driver,
      signal: controller.signal,
    });
    try {
      await eventually(
        async () =>
          await readFile(join(root, "analyzer-loaded")).then(
            () => true,
            () => undefined,
          ),
      );
      await stricterAnalyzer(analyzer);
      await writeFile(join(root, "analyze-now"), "continue");
      const old = await loaded;
      assert.equal(old.status, 0, old.stdout + old.stderr);
      assert.equal(record(JSON.parse(old.stdout))?.["kind"], "admitted");
      const fresh = await runCli(["fresh"], {
        directory: root,
        runtime: root,
        entryPoint: driver,
      });
      const cached = await runCli(["cached"], {
        directory: root,
        runtime: root,
        entryPoint: driver,
      });
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.deepEqual(JSON.parse(fresh.stdout), {
        kind: "refused",
        codes: ["direct-effect"],
      });
      assert.equal(cached.status, 0, cached.stderr);
      assert.deepEqual(JSON.parse(cached.stdout), JSON.parse(fresh.stdout));
    } finally {
      controller.abort();
      await loaded;
    }
  }));
