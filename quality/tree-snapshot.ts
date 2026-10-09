import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export interface TreeSnapshot {
  readonly identity: string;
  readonly entries: Readonly<Record<string, string>>;
}

export async function snapshotTree(directory: string): Promise<TreeSnapshot> {
  const root = await realpath(directory);
  const entries: Record<string, string> = {};
  await captureTree(root, "", entries);
  if (Object.keys(entries).length === 0) throw new Error("empty-staging-tree");
  const sorted = Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return {
    identity: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"),
    entries: sorted,
  };
}

async function captureTree(
  root: string,
  prefix: string,
  entries: Record<string, string>,
): Promise<void> {
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const name = join(prefix, entry.name);
    if (name === ".git") continue;
    const file = join(root, name);
    const status = await lstat(file);
    const mode = status.mode & 0o777;
    if (status.isDirectory()) {
      entries[name] = JSON.stringify({ kind: "directory", mode });
      await captureTree(root, name, entries);
      continue;
    }
    if (status.isSymbolicLink()) {
      entries[name] = JSON.stringify({
        kind: "link",
        mode,
        target: await internalLink(root, file),
      });
      continue;
    }
    if (!status.isFile()) throw new Error(`unsupported-staging-entry: ${name}`);
    entries[name] = JSON.stringify({
      kind: "file",
      mode,
      digest: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    });
  }
}

async function internalLink(root: string, file: string): Promise<string> {
  const target = await readlink(file);
  const resolved = await realpath(file);
  const path = relative(root, resolved);
  if (
    isAbsolute(target) ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path) ||
    !(await lstat(resolved)).isFile()
  )
    throw new Error(`unsafe-staging-link: ${file}`);
  return target;
}
