import { readFile, readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { setTimeout } from "node:timers/promises";
import type { Profiler } from "node:inspector";
import { parse } from "acorn";
import { convert } from "ast-v8-to-istanbul";
import istanbul from "istanbul-lib-coverage";
import ts from "typescript";
import { checkSuppressions } from "./suppression-approval.ts";
import { parseCheckTimeFactor } from "./test-execution.ts";
import type { CoverageRow } from "./coverage.ts";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function coverageRange(value: unknown): value is Profiler.CoverageRange {
  if (!record(value)) return false;
  return ["startOffset", "endOffset", "count"].every(
    (key) =>
      typeof value[key] === "number" &&
      Number.isSafeInteger(value[key]) &&
      value[key] >= 0,
  );
}

function coverageFunction(value: unknown): value is Profiler.FunctionCoverage {
  return (
    record(value) &&
    typeof value["functionName"] === "string" &&
    typeof value["isBlockCoverage"] === "boolean" &&
    Array.isArray(value["ranges"]) &&
    value["ranges"].length > 0 &&
    value["ranges"].every(coverageRange)
  );
}

function script(value: unknown): value is Profiler.ScriptCoverage {
  return (
    record(value) &&
    typeof value["url"] === "string" &&
    typeof value["scriptId"] === "string" &&
    Array.isArray(value["functions"]) &&
    value["functions"].length > 0 &&
    value["functions"].every(coverageFunction)
  );
}

async function coverageRecording(file: string): Promise<unknown> {
  const timeFactor = parseCheckTimeFactor(
    process.env["CLOVING_CHECK_TIME_FACTOR"],
  );
  const deadline = performance.now() + 5000 * timeFactor;
  let delay = 25;
  for (;;) {
    const content = await readFile(file, "utf8");
    try {
      const value: unknown = JSON.parse(content);
      return value;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (!(error instanceof SyntaxError) || remaining <= 0) throw error;
      await setTimeout(Math.min(delay, remaining));
      delay *= 2;
    }
  }
}

async function scriptCoverage(
  directory: string,
  expected: ReadonlySet<string>,
): Promise<Profiler.ScriptCoverage[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 0) throw new Error("missing-raw-coverage");
  const scripts: Profiler.ScriptCoverage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json"))
      throw new Error("invalid-raw-coverage-entry");
    const value = await coverageRecording(join(directory, entry.name));
    if (
      !record(value) ||
      !Array.isArray(value["result"]) ||
      !value["result"].every(script)
    )
      throw new Error("invalid-raw-coverage");
    scripts.push(
      ...value["result"].filter(
        (coverage) =>
          coverage.url.startsWith("file:") &&
          expected.has(fileURLToPath(coverage.url)),
      ),
    );
  }
  return scripts;
}

async function executedSource(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  checkSuppressions(
    [ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)],
    [],
  );
  if (
    /#\s*sourceMappingURL=(.*)\s*$/m.test(source) ||
    /\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file|start|stop)(?=\W|$)/.test(
      source,
    )
  )
    throw new Error("unadmitted-coverage-directive");
  if ([".ts", ".mts", ".cts"].includes(extname(file)))
    return stripTypeScriptTypes(source, { mode: "strip" });
  if ([".js", ".mjs", ".cjs"].includes(extname(file))) return source;
  throw new Error(`unsupported-coverage-source: ${file}`);
}

export async function collectCoverage(
  directory: string,
  files: readonly string[],
): Promise<CoverageRow[]> {
  const expected = new Set(
    await Promise.all(files.map((file) => realpath(file))),
  );
  const map = istanbul.createCoverageMap({});
  const sources = new Map<string, string>();
  for (const coverage of await scriptCoverage(directory, expected)) {
    const file = fileURLToPath(coverage.url);
    const code = sources.get(file) ?? (await executedSource(file));
    sources.set(file, code);
    const ast = parse(code, {
      ecmaVersion: "latest",
      sourceType: [".cts", ".cjs"].includes(extname(file))
        ? "script"
        : "module",
      locations: true,
    });
    map.merge(await convert({ code, coverage, ast }));
  }
  return map
    .files()
    .sort()
    .map((file) => {
      const summary = map.fileCoverageFor(file).toSummary();
      return {
        path: file,
        lines: summary.lines.pct,
        statements: summary.statements.pct,
        functions: summary.functions.pct,
        branches: summary.branches.pct,
      };
    });
}
