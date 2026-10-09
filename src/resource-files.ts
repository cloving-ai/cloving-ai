import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export async function collectResources(
  root: string,
  paths: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const base = await realpath(root);
  const entries: Array<[string, string]> = [];
  for (const path of paths) {
    const digest = await resourceDigest(base, path);
    if (digest !== null) entries.push([path, digest]);
  }
  return Object.fromEntries(entries);
}

async function resourceDigest(
  base: string,
  path: string,
): Promise<string | null> {
  if (isAbsolute(path)) return null;
  const file = await realpath(join(base, path)).catch(() => null);
  if (file === null) return null;
  const inside = relative(base, file);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    return null;
  if (!(await lstat(file)).isFile()) return null;
  const bytes = await readFile(file).catch(() => null);
  if (bytes === null) return null;
  return createHash("sha256").update(bytes).digest("hex");
}
