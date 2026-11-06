import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { attachmentFolder } from "./attachments.ts";
import { calls, type Calls } from "./github-calls.ts";
import { readRecord } from "./operation-journal.ts";
import { failureReason } from "./record-archive.ts";
import type { RecordSweep, SweepSettings } from "./record-sweep.ts";
import { treePlace } from "./work-tree.ts";
import {
  folderRunId,
  sharedRecordFolders,
  treeDue,
} from "../record-retention.ts";

export interface TreeSweepSettings extends Omit<SweepSettings, "files"> {
  readonly repository: string;
  readonly gh: readonly string[];
}

interface Tally {
  removed: number;
  open: number;
  readonly failures: string[];
}

const kinds = ["github", "journal"] as const;

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
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const targets = new Map<string, Set<string>>();
  for (const started of await startedRecords(directory)) {
    const target: unknown = Reflect.get(Object(started), "target");
    const runId = folderRunId(started);
    if (typeof target !== "string" || target.startsWith("branch:")) continue;
    if (runId === undefined) continue;
    targets.set(target, (targets.get(target) ?? new Set()).add(runId));
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
  request: { readonly github: Calls; readonly target: string },
): Promise<void> {
  const worktrees = join(settings.directory, "worktrees");
  const place = treePlace({ worktrees, target: request.target });
  const repository = (parts: readonly string[]) =>
    request.github.git(settings.repository, parts);
  await repository(["worktree", "remove", "--force", place.path]);
  if ((await repository(["branch", "--list", place.branch])).trim() !== "")
    await repository(["branch", "-D", place.branch]);
  await rm(attachmentFolder({ worktrees, target: request.target }), {
    recursive: true,
    force: true,
  });
}

async function handledTree(
  settings: TreeSweepSettings,
  request: {
    readonly github: Calls;
    readonly target: string;
    readonly tally: Tally;
  },
): Promise<void> {
  const { github, target, tally } = request;
  const place = treePlace({
    worktrees: join(settings.directory, "worktrees"),
    target,
  });
  try {
    if ((await openPulls(github, place.branch)) > 0) {
      tally.open += 1;
      return;
    }
    await removedTree(settings, { github, target });
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

async function swept(settings: TreeSweepSettings): Promise<void> {
  const days = settings.retention.days;
  if (days === null) return;
  const worktrees = join(settings.directory, "worktrees");
  const targets = [...(await targetRuns(settings.directory))].filter(
    ([target]) => existsSync(treePlace({ worktrees, target }).path),
  );
  const runs = await settings.runs([
    ...new Set(targets.flatMap(([, runIds]) => [...runIds])),
  ]);
  const now = settings.now();
  const github = calls(settings, AbortSignal.timeout(600_000));
  const tally: Tally = { removed: 0, open: 0, failures: [] };
  for (const [target, runIds] of targets)
    if (
      treeDue(
        [...runIds].map((runId) => runs[runId]),
        { now, days },
      )
    )
      await handledTree(settings, { github, target, tally });
  settings.log(countLine(tally));
}

export function treeSweep(settings: TreeSweepSettings): RecordSweep {
  return {
    pass: () =>
      swept(settings).catch((error: unknown) => {
        settings.log(
          `retention: work trees failed (${failureReason(error)})\n`,
        );
      }),
  };
}
