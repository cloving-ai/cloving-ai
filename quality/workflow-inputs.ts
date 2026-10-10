export async function inspectWorkflowInputs(
  directory: string,
  declared: {
    readonly sources: readonly string[];
    readonly dependencies: readonly string[];
  },
): Promise<Readonly<Record<string, string | null>>> {
  const { sources, dependencies } = declared;
  if (sources.length === 0) throw new Error("empty-workflow-inputs");
  const root = await realpath(directory);
  const admitted = await Promise.all(
    dependencies.map((path) => realpath(path)),
  );
  const inputs: Record<string, string | null> = {};
  await inspectConfigurations(root, inputs);
  const files: string[] = [];
  const pending = [...sources];
  while (pending.length > 0) {
    const source = pending.pop();
    if (!source) throw new Error("missing-workflow-source");
    const canonical = await realpath(source);
    if (!canonical.startsWith(root + sep))
      throw new Error(`outside-workflow-input: ${source}`);
    if (inputs[canonical]) continue;
    const text = await readFile(canonical, "utf8");
    inputs[canonical] = createHash("sha256").update(text).digest("hex");
    files.push(canonical);
    pending.push(
      ...(await localImports(
        { file: canonical, text },
        { root, dependencies: admitted },
      )),
    );
  }
  dependencyGraph(
    ts.createProgram(files, {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true,
    }),
  );
  return inputs;
}

async function inspectConfigurations(
  root: string,
  inputs: Record<string, string | null>,
): Promise<void> {
  for (const directory of ancestorDirectories(root)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const file = join(directory, name);
      inputs[file] = null;
      if (!existsSync(file)) continue;
      if (directory !== root)
        throw new Error(`unadmitted-ancestor-configuration: ${file}`);
      const content = await readFile(file, "utf8");
      if (JSON.stringify(JSON.parse(content)) !== "{}")
        throw new Error(`unqualified-workflow-configuration: ${file}`);
      inputs[file] = createHash("sha256").update(content).digest("hex");
    }
  }
  await rejectNestedConfigurations(root, root);
}

function ancestorDirectories(directory: string): string[] {
  const parent = dirname(directory);
  return parent === directory
    ? [directory]
    : [directory, ...ancestorDirectories(parent)];
}

async function rejectNestedConfigurations(
  directory: string,
  root: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (directory === root && ["node_modules", ".git"].includes(entry.name))
      continue;
    if (entry.isSymbolicLink())
      throw new Error(`outside-workflow-input: ${file}`);
    if (entry.isDirectory()) {
      await rejectNestedConfigurations(file, root);
      continue;
    }
    if (
      directory !== root &&
      ["tsconfig.json", "jsconfig.json"].includes(entry.name)
    )
      throw new Error(`unqualified-workflow-configuration: ${file}`);
  }
}

async function localImports(
  source: { readonly file: string; readonly text: string },
  scope: { readonly root: string; readonly dependencies: readonly string[] },
): Promise<string[]> {
  const { file, text } = source;
  const { root, dependencies } = scope;
  const result: string[] = [];
  for (const reference of ts.preProcessFile(text).importedFiles) {
    if (isBuiltin(reference.fileName)) continue;
    const resolved = ts.resolveModuleName(
      reference.fileName,
      file,
      { moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true },
      ts.sys,
    ).resolvedModule;
    if (!resolved)
      throw new Error(`unresolved-workflow-input: ${reference.fileName}`);
    const target = await realpath(resolved.resolvedFileName);
    if (dependencies.some((directory) => target.startsWith(directory + sep)))
      continue;
    if (!target.startsWith(root + sep))
      throw new Error(`outside-workflow-input: ${target}`);
    result.push(target);
  }
  return result;
}
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { dependencyGraph } from "./dependency-graph.ts";
