import { resolve, sep } from "node:path";
import { ownedProcesses, type TurnOwner } from "./turn-owners.ts";

export interface TreeProcess {
  readonly processId: number;
  readonly parent: number;
  readonly group: number;
  readonly user: number;
  readonly seconds: number;
  readonly command: string;
  readonly directory?: string;
}

export function inTree(entry: TreeProcess, directory: string): boolean {
  if (
    entry.processId <= 1 ||
    entry.processId === process.pid ||
    entry.directory === undefined
  )
    return false;
  const root = resolve(directory);
  return entry.directory === root || entry.directory.startsWith(root + sep);
}

export function signalTargets(
  entries: readonly TreeProcess[],
  request: {
    readonly directory: string;
    readonly user: number | undefined;
    readonly owned: ReadonlyMap<number, string>;
  },
): { readonly found: TreeProcess[]; readonly targets: readonly number[] } {
  const maySignal = (entry: TreeProcess) =>
    entry.user === request.user &&
    inTree(entry, request.directory) &&
    !request.owned.has(entry.processId);
  const found = entries.filter(maySignal);
  const targets: number[] = [];
  for (const entry of found) {
    const safeGroup =
      entry.group > 1 &&
      entries.filter((other) => other.group === entry.group).every(maySignal);
    const target = safeGroup ? -entry.group : entry.processId;
    if (!targets.includes(target)) targets.push(target);
  }
  return { found, targets };
}

export interface Snapshot {
  readonly entries: readonly TreeProcess[];
  readonly owners: readonly TurnOwner[];
}

export function stoppable(
  snapshot: Snapshot,
  directory: string,
): readonly TreeProcess[] {
  const owned = ownedProcesses(snapshot.entries, snapshot.owners);
  return snapshot.entries.filter(
    (entry) => inTree(entry, directory) && !owned.has(entry.processId),
  );
}

export function keptLines(
  snapshot: Snapshot,
  request: {
    readonly directory: string;
    readonly user: number | undefined;
    readonly logged: Set<number>;
  },
): readonly string[] {
  const owned = ownedProcesses(snapshot.entries, snapshot.owners);
  const lines: string[] = [];
  for (const entry of snapshot.entries) {
    const owner = owned.get(entry.processId);
    if (
      owner === undefined ||
      request.logged.has(entry.processId) ||
      entry.user !== request.user ||
      !inTree(entry, request.directory)
    )
      continue;
    request.logged.add(entry.processId);
    lines.push(
      `turn: kept process ${String(entry.processId)} (${entry.command}) of the active run ${owner} in the work tree ${request.directory}\n`,
    );
  }
  return lines;
}
