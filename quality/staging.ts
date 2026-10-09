import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { snapshotTree } from "./tree-snapshot.ts";

export async function stageCandidate(
  source: string,
  destination: string,
): Promise<{ directory: string; identity: string }> {
  const origin = await realpath(source);
  const directory = join(
    await realpath(dirname(destination)),
    basename(destination),
  );
  for (const path of [
    relative(origin, directory),
    relative(directory, origin),
  ]) {
    if (path !== ".." && !path.startsWith(`..${sep}`))
      throw new Error("overlapping-staging-paths");
  }
  const before = await snapshotTree(origin);
  await mkdir(directory, { mode: 0o700 });
  try {
    await cp(origin, directory, {
      recursive: true,
      force: false,
      verbatimSymlinks: true,
      filter: (file) => file !== join(origin, ".git"),
    });
    const staged = await snapshotTree(directory);
    if (
      staged.identity !== before.identity ||
      (await snapshotTree(origin)).identity !== before.identity
    )
      throw new Error("staging-inputs-changed");
    return { directory, identity: staged.identity };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
