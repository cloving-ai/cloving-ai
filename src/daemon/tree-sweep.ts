import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
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

const kinds = ["github", "journal"] as const;
const treesPerPass = 3;
const readMilliseconds = 10_000;
const gitMilliseconds = 600_000;

function runsFolder(directory: string): string {
  return join(directory, "journal", "trees");
}

async function storedRuns(directory: string): Promise<Map<string, TargetRuns>> {
  const folder = runsFolder(directory);
  const found = new Map<string, TargetRuns>();
  for (const name of await readdir(folder).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const record: unknown = await readRecord(folder, name).catch(() => ({}));
    const target: unknown = Reflect.get(Object(record), "target");
    const listed: unknown = Reflect.get(Object(record), "runIds");
    if (typeof target !== "string" || !Array.isArray(listed)) continue;
    const runIds = new Set(
      listed.filter((runId): runId is string => typeof runId === "string"),
    );
    found.set(target, { runIds, stored: runIds.size });
  }
  return found;
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
  item: { readonly target: string; readonly entry: TargetRuns },
): Promise<boolean> {
  const { target, entry } = item;
  const worktrees = join(directory, "worktrees");
  if (!existsSync(treePlace({ worktrees, target }).path)) {
    await rm(join(runsFolder(directory), runsName(target)), { force: true });
    return false;
  }
  if (entry.runIds.size > entry.stored)
    await storeRuns(directory, { target, runIds: entry.runIds });
  return true;
}

async function storedTrees(
  directory: string,
): Promise<readonly (readonly [string, TargetRuns])[]> {
  const present: (readonly [string, TargetRuns])[] = [];
  for (const [target, entry] of await targetRuns(directory))
    if (await presentTree(directory, { target, entry }))
      present.push([target, entry]);
  return present;
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

async function targetRuns(
  directory: string,
): Promise<ReadonlyMap<string, TargetRuns>> {
  const targets = await storedRuns(directory);
  for (const started of await startedRecords(directory)) {
    const target: unknown = Reflect.get(Object(started), "target");
    const runId = folderRunId(started);
    if (typeof target !== "string" || target.startsWith("branch:")) continue;
    if (runId === undefined) continue;
    const entry = targets.get(target) ?? { runIds: new Set(), stored: 0 };
    entry.runIds.add(runId);
    targets.set(target, entry);
  }
  return targets;
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
  const targets = await storedTrees(settings.directory);
  const runs = await settings.runs([
    ...new Set(targets.flatMap(([, { runIds }]) => [...runIds])),
  ]);
  const now = settings.now();
  const due = targets
    .filter(([, { runIds }]) =>
      treeDue(
        [...runIds].map((runId) => runs[runId]),
        { now, days },
      ),
    )
    .map(([target]) => target)
    .sort();
  const batch = batchAfter(due, { cursor: sweep.cursor, size: treesPerPass });
  sweep.cursor = batch.at(-1) ?? "";
  const tally: Tally = { removed: 0, open: 0, failures: [] };
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
