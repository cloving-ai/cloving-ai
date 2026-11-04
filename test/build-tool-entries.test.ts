import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";

const root = resolve(import.meta.dirname, "..");
const startedByPath = /[`'"](?:\.\/|tools\/)([\w-]+)\$\{/g;
const startedAsTool = /toolProcess\(\{\s*tool:\s*"([\w-]+)"/g;

async function sourceFiles(folder: string): Promise<readonly string[]> {
  const entries = await readdir(join(root, folder), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

async function startedTools(): Promise<readonly string[]> {
  const files = [
    ...(await sourceFiles("src")),
    ...(await sourceFiles("tools")),
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(file, "utf8")),
  );
  const names = sources.flatMap((source) =>
    [...source.matchAll(startedByPath), ...source.matchAll(startedAsTool)].map(
      (match) => `tools/${String(match[1])}.ts`,
    ),
  );
  return [...new Set(names)].sort();
}

async function buildIncludes(): Promise<readonly string[]> {
  const parsed = record(
    JSON.parse(await readFile(join(root, "tsconfig.build.json"), "utf8")),
  );
  const include: unknown = parsed?.["include"];
  assert.ok(Array.isArray(include));
  return include.filter((entry) => typeof entry === "string");
}

function missingTools(
  included: readonly string[],
  started: readonly string[],
): readonly string[] {
  return started.filter((tool) => !included.includes(tool));
}

await test("CLV-294 the build includes each tool that Cloving starts by path", async () => {
  const started = await startedTools();
  for (const tool of [
    "tools/self-host-reload.ts",
    "tools/compile-workflows.ts",
    "tools/self-host.ts",
    "tools/workflow-command.ts",
    "tools/template-command.ts",
    "tools/red-green-command.ts",
  ])
    assert.ok(started.includes(tool), tool);
  assert.deepEqual(missingTools(await buildIncludes(), started), []);
});

await test("CLV-294 a build list without a started tool names the missing tool", async () => {
  const started = await startedTools();
  for (const tool of [
    "tools/self-host-reload.ts",
    "tools/workflow-command.ts",
  ]) {
    const included = (await buildIncludes()).filter((entry) => entry !== tool);
    assert.deepEqual(missingTools(included, started), [tool]);
  }
});
