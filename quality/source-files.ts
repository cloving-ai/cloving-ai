import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const extensions = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const excludedDirectories = new Set([".git", "node_modules", "dist"]);
const metadata = new Set([".gitignore", ".npmrc", "LICENSE"]);

async function discover(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name))
        files.push(...(await discover(path)));
      continue;
    }
    if (entry.isSymbolicLink())
      throw new Error(`Source inventory contains a symbolic link: ${path}`);
    if (extensions.has(extname(entry.name))) {
      files.push(path);
      continue;
    }
    if (
      !metadata.has(entry.name) &&
      ![".json", ".md"].includes(extname(entry.name))
    )
      throw new Error(
        `Source check found an unsupported inventory file: ${path}`,
      );
  }
  return files;
}

export async function sourceFiles(directory: string): Promise<string[]> {
  const files = await discover(resolve(directory));
  if (files.length === 0)
    throw new Error("Cannot check an empty source inventory");
  return files.sort();
}
