import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { attachmentFolder } from "./attachments.ts";
import { calls, type Calls } from "./github-calls.ts";
import { operationKey, readRecord, writeRecord } from "./operation-journal.ts";
import { failureReason } from "./record-archive.ts";
import type { StoppableSweep, SweepSettings } from "./record-sweep.ts";
import { treePlace } from "./work-tree.ts";
import {
  batchAfter,
  folderRunId,
  sharedRecordFolders,
  treeDue,
} from "../record-retention.ts";

export interface TreeSweepSettings extends Omit<SweepSettings, "files"> {
  readonly repository: string;
  readonly gh: readonly string[];
  readonly readMilliseconds?: number;
}

interface Sweep {
  readonly settings: TreeSweepSettings;
  cursor: string;
}

interface Tally {
  removed: number;
  open: number;
  readonly failures: string[];
}

interface TargetRuns {
  readonly runIds: Set<string>;
  readonly stored: number;
}

interface TargetLists {
  readonly targets: Map<string, TargetRuns>;
  readonly unreadable: Set<string>;
}

interface PresentTree {
  readonly target: string;
  readonly runIds: ReadonlySet<string>;
  readonly bornAt: number;
}

interface FoundTrees {
  readonly present: readonly PresentTree[];
  readonly unreadable: readonly string[];
}

const kinds = ["github", "journal"] as const;
const treesPerPass = 3;
const readMilliseconds = 10_000;
const gitMilliseconds = 600_000;

function runsFolder(directory: string): string {
  return join(directory, "journal", "trees");
}

async function listNames(folder: string): Promise<readonly string[]> {
  const names = await readdir(folder).catch((error: unknown) => {
    if (failureReason(error) === "ENOENT") return [];
    throw error;
  });
  return names.filter((name) => name.endsWith(".json"));
}

function textItems(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length === value.length ? items : undefined;
}

function targeted(value: unknown): value is { readonly target: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "target" in value &&
    typeof value.target === "string"
  );
}

async function storedRuns(directory: string): Promise<TargetLists> {
  const folder = runsFolder(directory);
  const lists: TargetLists = { targets: new Map(), unreadable: new Set() };
  for (const name of await listNames(folder)) {
    const record = await readRecord(folder, name).catch(() => undefined);
    if (!targeted(record)) {
      lists.unreadable.add(name);
      continue;
    }
    const { target } = record;
    const listed = textItems("runIds" in record ? record.runIds : undefined);
    const runIds = new Set(listed);
    lists.targets.set(target, { runIds, stored: runIds.size });
    if (listed !== undefined) continue;
    lists.unreadable.add(name);
    lists.unreadable.add(runsName(target));
  }
  return lists;
}

function runsName(target: string): string {
  return `${operationKey(target)}.json`;
}

async function storeRuns(
  directory: string,
  entry: { readonly target: string; readonly runIds: ReadonlySet<string> },
): Promise<void> {
  await writeRecord(runsFolder(directory), {
    name: runsName(entry.target),
    value: { target: entry.target, runIds: [...entry.runIds].sort() },
  });
}

async function presentTree(
  directory: string,
  item: {
    readonly target: string;
    readonly entry: TargetRuns;
    readonly unreadable: boolean;
  },
): Promise<number | undefined> {
  const { target, entry } = item;
  const worktrees = join(directory, "worktrees");
  const { path } = treePlace({ worktrees, target });
  if (!existsSync(path)) {
    await rm(join(runsFolder(directory), runsName(target)), { force: true });
    return undefined;
  }
  if (!item.unreadable && entry.runIds.size > entry.stored)
    await storeRuns(directory, { target, runIds: entry.runIds });
  const link = await stat(join(path, ".git")).catch(() => undefined);
  return link?.mtimeMs;
}

async function storedTrees(directory: string): Promise<FoundTrees> {
  const lists = await targetRuns(directory);
  const present: PresentTree[] = [];
  const unreadable: string[] = [];
  for (const [target, entry] of lists.targets) {
    const listUnreadable = lists.unreadable.has(runsName(target));
    const bornAt = await presentTree(directory, {
      target,
      entry,
      unreadable: listUnreadable,
    });
    if (bornAt === undefined) continue;
    if (listUnreadable) unreadable.push(target);
    else present.push({ target, runIds: entry.runIds, bornAt });
  }
  return { present, unreadable: unreadable.sort() };
}

async function startedRecords(directory: string): Promise<unknown[]> {
  const records: unknown[] = [];
  for (const kind of kinds)
    for (const entry of await readdir(join(directory, kind), {
      withFileTypes: true,
    }).catch(() => []))
      if (
        entry.isDirectory() &&
        !sharedRecordFolders.includes(`${kind}/${entry.name}`)
      )
        records.push(
          await readRecord(
            join(directory, kind, entry.name),
            "started.json",
          ).catch(() => undefined),
        );
  return records;
}

async function targetRuns(directory: string): Promise<TargetLists> {
  const lists = await storedRuns(directory);
  const { targets } = lists;
  for (const started of await startedRecords(directory)) {
    const runId = folderRunId(started);
    if (!targeted(started) || started.target.startsWith("branch:")) continue;
    if (runId === undefined) continue;
    const { target } = started;
    const entry = targets.get(target) ?? { runIds: new Set(), stored: 0 };
    entry.runIds.add(runId);
    targets.set(target, entry);
  }
  return lists;
}

async function openPulls(github: Calls, branch: string): Promise<number> {
  const listed: unknown = JSON.parse(
    await github.gh([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
    ]),
  );
  if (!Array.isArray(listed)) throw new Error("github-reply-invalid");
  return listed.length;
}

async function removedTree(
  settings: TreeSweepSettings,
  target: string,
): Promise<void> {
  const worktrees = join(settings.directory, "worktrees");
  const place = treePlace({ worktrees, target });
  const local = calls(settings, AbortSignal.timeout(gitMilliseconds));
  const repository = (parts: readonly string[]) =>
    local.git(settings.repository, parts);
  await repository(["worktree", "remove", "--force", place.path]);
  if ((await repository(["branch", "--list", place.branch])).trim() !== "")
    await repository(["branch", "-D", place.branch]);
  await rm(attachmentFolder({ worktrees, target }), {
    recursive: true,
    force: true,
  });
}

async function handledTree(
  settings: TreeSweepSettings,
  request: {
    readonly target: string;
    readonly tally: Tally;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const { target, tally, signal } = request;
  const place = treePlace({
    worktrees: join(settings.directory, "worktrees"),
    target,
  });
  const deadline = AbortSignal.timeout(
    settings.readMilliseconds ?? readMilliseconds,
  );
  const github = calls(settings, AbortSignal.any([signal, deadline]));
  try {
    if ((await openPulls(github, place.branch)) > 0) {
      tally.open += 1;
      return;
    }
    await removedTree(settings, target);
    tally.removed += 1;
  } catch (error) {
    tally.failures.push(`${target}: ${failureReason(error)}`);
  }
}

function countLine(tally: Tally): string {
  const failed =
    tally.failures.length === 0
      ? ""
      : `, failed ${String(tally.failures.length)} (${tally.failures.slice(0, 1).join("")})`;
  return `retention: removed ${String(tally.removed)} work trees, kept ${String(tally.open)} with an open pull request${failed}\n`;
}

async function swept(sweep: Sweep, signal: AbortSignal): Promise<void> {
  const { settings } = sweep;
  const days = settings.retention.days;
  if (days === null) return;
  const found = await storedTrees(settings.directory);
  const runs = await settings.runs([
    ...new Set(found.present.flatMap(({ runIds }) => [...runIds])),
  ]);
  const now = settings.now();
  const due = found.present
    .filter(({ runIds, bornAt }) =>
      treeDue(
        [...runIds].map((runId) => runs[runId]),
        { now, days, bornAt },
      ),
    )
    .map(({ target }) => target)
    .sort();
  const batch = batchAfter(due, { cursor: sweep.cursor, size: treesPerPass });
  sweep.cursor = batch.at(-1) ?? "";
  const tally: Tally = {
    removed: 0,
    open: 0,
    failures: found.unreadable.map(
      (target) => `${target}: tree-runs-unreadable`,
    ),
  };
  for (const target of batch) {
    if (signal.aborted) break;
    await handledTree(settings, { target, tally, signal });
  }
  settings.log(countLine(tally));
}

export function treeSweep(settings: TreeSweepSettings): StoppableSweep {
  const sweep: Sweep = { settings, cursor: "" };
  return {
    pass: (signal) =>
      swept(sweep, signal).catch((error: unknown) => {
        settings.log(
          `retention: work trees failed (${failureReason(error)})\n`,
        );
      }),
  };
}
