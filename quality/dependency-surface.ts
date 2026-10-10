import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface DependencySurface {
  readonly files: Readonly<Record<string, string>>;
  readonly digest: string;
}

export async function dependencySurface(
  directory: string,
  artifacts: readonly string[],
): Promise<DependencySurface> {
  if (artifacts.length === 0)
    throw new Error("empty-runtime-artifact-inventory");
  for (const file of artifacts) {
    if (
      isAbsolute(file) ||
      file.split(/[\\/]/).some((part) => [".", "..", ""].includes(part))
    )
      throw new Error(`invalid-artifact-path: ${file}`);
  }
  const files: Record<string, string> = {};
  await capture("", {
    directory: await realpath(directory),
    artifacts,
    files,
  });
  if (!files["metadata:package.json"] || !files["metadata:package-lock.json"])
    throw new Error("missing-npm-dependency-inputs");
  for (const file of artifacts) {
    if (!files[`artifact:${file}`])
      throw new Error(`missing-runtime-artifact: ${file}`);
  }
  const sorted = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((file) => [file, files[file]]),
  );
  return {
    files,
    digest: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"),
  };
}

function categories(file: string, artifacts: readonly string[]): string[] {
  const result: string[] = [];
  const parts = file.split(sep);
  if (parts.includes("node_modules")) result.push("installed");
  if (parts.includes("vendor")) result.push("vendor");
  if (
    [
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "bun.lock",
      "bun.lockb",
      ".npmrc",
      ".yarnrc",
      ".yarnrc.yml",
    ].includes(basename(file))
  )
    result.push("metadata");
  if (artifacts.includes(file)) result.push("artifact");
  return result;
}

async function capture(
  prefix: string,
  walk: {
    readonly directory: string;
    readonly artifacts: readonly string[];
    readonly files: Record<string, string>;
  },
): Promise<void> {
  const { directory, artifacts, files } = walk;
  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const file = join(prefix, entry.name);
    if (file === ".git") continue;
    if (entry.isDirectory()) {
      await capture(file, walk);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink())
      throw new Error(`unsupported-dependency-entry: ${file}`);
    const groups = categories(file, artifacts);
    if (entry.isSymbolicLink() && groups.length === 0)
      throw new Error(`unqualified-dependency-link: ${file}`);
    if (groups.length === 0) continue;
    const identity = await fileIdentity(directory, file);
    for (const group of groups) files[`${group}:${file}`] = identity;
  }
}

async function fileIdentity(directory: string, file: string): Promise<string> {
  const path = join(directory, file);
  const status = await lstat(path);
  const target = status.isSymbolicLink() ? await readlink(path) : "";
  const resolved = await realpath(path);
  const targetStatus = await lstat(resolved);
  const relativeTarget = relative(resolve(directory), resolved);
  if (
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget) ||
    !targetStatus.isFile()
  )
    throw new Error(`unqualified-dependency-link: ${file}`);
  return JSON.stringify({
    target,
    mode: status.mode & 0o777,
    targetMode: targetStatus.mode & 0o777,
    digest: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
}
