import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export interface FileInventory {
  readonly sources: readonly string[];
  readonly metadata: readonly string[];
  readonly generated: readonly string[];
}

const sourceExtensions = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const metadataNames = new Set([
  ".gitignore",
  ".npmrc",
  "LICENSE",
  ".github/workflows/ci.yml",
]);

async function discover(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`inventory-symlink: ${path}`);
    if (path === ".git") continue;
    if (entry.isDirectory()) {
      if (path === "node_modules") continue;
      files.push(...(await discover(join(directory, entry.name), path)));
      continue;
    }
    if (!entry.isFile())
      throw new Error(`unsupported-inventory-entry: ${path}`);
    files.push(path);
  }
  return files.sort();
}

export async function inspectInventory(
  directory: string,
  generated: Readonly<Record<string, string>>,
): Promise<FileInventory> {
  const sources: string[] = [];
  const metadata: string[] = [];
  const outputs: string[] = [];
  for (const file of await discover(directory)) {
    const expected = generated[file];
    if (expected !== undefined) {
      const digest = createHash("sha256")
        .update(await readFile(join(directory, file)))
        .digest("hex");
      if (digest !== expected)
        throw new Error(`generated-digest-mismatch: ${file}`);
      outputs.push(file);
      continue;
    }
    if (sourceExtensions.has(extname(file))) {
      sources.push(file);
      continue;
    }
    if ([".json", ".md"].includes(extname(file)) || metadataNames.has(file)) {
      metadata.push(file);
      continue;
    }
    throw new Error(`unsupported-inventory-file: ${file}`);
  }
  for (const file of Object.keys(generated)) {
    if (!outputs.includes(file))
      throw new Error(`missing-generated-output: ${file}`);
  }
  if (sources.length === 0) throw new Error("empty-source-inventory");
  return { sources, metadata, generated: outputs };
}
