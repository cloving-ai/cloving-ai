import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export interface SourceIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export interface ScanSource {
  readonly path: string;
  readonly root: string;
  readonly identities: readonly SourceIdentity[];
  readonly size: number;
  readonly modified: number;
  readonly changed: number;
  readonly kind: "file" | "subtree";
}

export function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)
  );
}

async function inspectComponents(path: string) {
  const identities: SourceIdentity[] = [];
  let ancestor = path;
  const ancestors: string[] = [];
  for (;;) {
    ancestors.unshift(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let stats: Stats | undefined;
  for (const component of ancestors) {
    const next = await lstat(noFollowPath(component));
    if (next.isSymbolicLink()) throw new Error("symbolic-link");
    identities.unshift({ path: component, device: next.dev, inode: next.ino });
    stats = next;
  }
  if (stats === undefined) throw new Error("source-unreadable");
  return { identities, stats };
}

export async function inspectScanSource(
  path: string,
  root: string,
): Promise<ScanSource> {
  const { identities, stats } = await inspectComponents(path);
  const canonicalPath = await realpath(path);
  const canonicalRoot = path === root ? canonicalPath : root;
  if (!contained(canonicalRoot, canonicalPath)) throw new Error("outside-root");
  const canonicalStats = await lstat(noFollowPath(canonicalPath));
  if (canonicalStats.dev !== stats.dev || canonicalStats.ino !== stats.ino)
    throw new Error("source-changed");
  const confirmation = await inspectComponents(path);
  if (JSON.stringify(confirmation.identities) !== JSON.stringify(identities))
    throw new Error("source-changed");
  if (!stats.isDirectory() && !stats.isFile())
    throw new Error("nonregular-file");
  return {
    path,
    root: canonicalRoot,
    identities,
    size: stats.size,
    modified: stats.mtimeMs,
    changed: stats.ctimeMs,
    kind: stats.isDirectory() ? "subtree" : "file",
  };
}

export function noFollowPath(path: string): string {
  if (process.platform !== "darwin") throw new Error("platform-unsupported");
  if (!isAbsolute(path)) throw new Error("source-unreadable");
  return `/.nofollow${path}`;
}

async function metadata(path: string) {
  try {
    return await lstat(noFollowPath(path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
}

async function repositoryMarker(path: string): Promise<boolean> {
  if (await metadata(join(path, ".git"))) return true;
  const [head, objects, references] = await Promise.all([
    metadata(join(path, "HEAD")),
    metadata(join(path, "objects")),
    metadata(join(path, "refs")),
  ]);
  return (
    head?.isFile() === true &&
    objects?.isDirectory() === true &&
    references?.isDirectory() === true
  );
}

export async function refuseRepositoryRoot(path: string): Promise<void> {
  let ancestor = path;
  for (;;) {
    if (await repositoryMarker(ancestor)) throw new Error("repository-root");
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

export function sourceFailure(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ELOOP")
    return "symbolic-link";
  const reason = error instanceof Error ? error.message : "";
  return [
    "symbolic-link",
    "outside-root",
    "nonregular-file",
    "repository-root",
    "source-changed",
    "non-directory-root",
  ].includes(reason)
    ? reason
    : "source-unreadable";
}

export async function verifyScanSource(expected: ScanSource): Promise<void> {
  const current = await inspectScanSource(expected.path, expected.root);
  if (
    JSON.stringify(current.identities) !== JSON.stringify(expected.identities)
  )
    throw new Error("source-changed");
  if (
    expected.kind === "file" &&
    (current.size !== expected.size ||
      current.modified !== expected.modified ||
      current.changed !== expected.changed)
  )
    throw new Error("source-changed");
}

export function verifyOpenSource(expected: ScanSource, stats: Stats): void {
  const identity = expected.identities[0];
  if (
    !stats.isFile() ||
    identity === undefined ||
    stats.dev !== identity.device ||
    stats.ino !== identity.inode ||
    stats.size !== expected.size ||
    stats.mtimeMs !== expected.modified ||
    stats.ctimeMs !== expected.changed
  )
    throw new Error("source-changed");
}

export function verifyScanAncestor(
  expected: ScanSource,
  current: ScanSource,
): void {
  const ancestors = current.identities.slice(-expected.identities.length);
  if (
    expected.identities.some(
      (identity, index) =>
        identity.device !== ancestors[index]?.device ||
        identity.inode !== ancestors[index].inode,
    )
  )
    throw new Error("source-changed");
}
