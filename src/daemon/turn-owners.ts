import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { processMatch, type RecordedProcess } from "./process-identity.ts";

export interface TurnOwner {
  readonly runId: string;
  readonly processId: number;
}

export interface OwnedProcess {
  readonly processId: number;
  readonly parent: number;
  readonly group: number;
}

interface ActiveTurn extends TurnOwner {
  readonly directory: string;
  readonly kept?: RecordedProcess;
}

const activeTurns = new Set<ActiveTurn>();

function dropKept(processId: number): void {
  for (const turn of activeTurns)
    if (turn.kept !== undefined && turn.processId === processId)
      activeTurns.delete(turn);
}

export function ownTurn(directory: string, owner: TurnOwner): () => void {
  dropKept(owner.processId);
  const turn: ActiveTurn = { directory, ...owner };
  activeTurns.add(turn);
  return () => {
    activeTurns.delete(turn);
  };
}

export function keepTurn(
  directory: string,
  kept: {
    readonly runId: string;
    readonly launch: RecordedProcess | null | undefined;
  },
): void {
  const launch = kept.launch ?? undefined;
  if (launch === undefined) return;
  dropKept(launch.processId);
  activeTurns.add({
    directory,
    runId: kept.runId,
    processId: launch.processId,
    kept: launch,
  });
}

async function live(turn: ActiveTurn): Promise<boolean> {
  if (turn.kept === undefined) return true;
  if ((await processMatch(turn.kept)) !== "other") return true;
  activeTurns.delete(turn);
  return false;
}

function canonical(directory: string): Promise<string> {
  return realpath(directory).catch(() => resolve(directory));
}

export async function activeOwners(
  directory: string,
): Promise<readonly TurnOwner[]> {
  const tree = await canonical(directory);
  const turns = [...activeTurns];
  const trees = await Promise.all(
    turns.map((turn) => canonical(turn.directory)),
  );
  const matching = turns.filter((_, index) => trees[index] === tree);
  const current = await Promise.all(matching.map(live));
  return matching
    .filter((_, index) => current[index])
    .map(({ runId, processId }) => ({ runId, processId }));
}

function childrenOf(
  processes: readonly OwnedProcess[],
): ReadonlyMap<number, readonly number[]> {
  const children = new Map<number, number[]>();
  for (const entry of processes)
    children.set(entry.parent, [
      ...(children.get(entry.parent) ?? []),
      entry.processId,
    ]);
  return children;
}

function descendants(
  root: number,
  children: ReadonlyMap<number, readonly number[]>,
): readonly number[] {
  const found: number[] = [];
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (found.includes(next)) continue;
    found.push(next);
    pending.push(...(children.get(next) ?? []));
  }
  return found;
}

function groupMembers(
  processes: readonly OwnedProcess[],
  root: number,
): readonly number[] {
  const leads = processes.some(
    (entry) => entry.processId === root && entry.group === root,
  );
  return leads
    ? processes
        .filter((entry) => entry.group === root)
        .map((entry) => entry.processId)
    : [];
}

export function ownedProcesses(
  processes: readonly OwnedProcess[],
  owners: readonly TurnOwner[],
): ReadonlyMap<number, string> {
  const children = childrenOf(processes);
  const owned = new Map<number, string>();
  for (const owner of owners)
    for (const processId of [
      ...descendants(owner.processId, children),
      ...groupMembers(processes, owner.processId),
    ])
      if (!owned.has(processId)) owned.set(processId, owner.runId);
  return owned;
}
