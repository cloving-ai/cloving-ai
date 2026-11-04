import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  archivedFolder,
  archiveReady,
  failureReason,
  nodeFiles,
  storedFiles,
  type RecordFiles,
} from "./record-archive.ts";
import {
  batchAfter,
  folderRunId,
  retentionVerdict,
  sharedRecordFolders,
  type RetentionSettings,
  type RetentionVerdict,
  type StoredRun,
} from "../record-retention.ts";
import type { HostPorts } from "../service/service.ts";

export interface SweepSettings {
  readonly directory: string;
  readonly retention: RetentionSettings;
  readonly runs: (
    runIds: readonly string[],
  ) => Promise<Readonly<Record<string, StoredRun>>>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly files?: RecordFiles;
}

export interface RecordSweep {
  readonly pass: () => Promise<void>;
}

export interface RetentionLoop {
  readonly stop: () => Promise<void>;
}

export const retentionIntervalMilliseconds = 3_600_000;

interface Examined {
  readonly path: string;
  readonly started: unknown;
  readonly changedAt: number;
}

interface Sweep {
  readonly settings: SweepSettings;
  cursor: string;
}

interface Tally {
  readonly counts: Record<RetentionVerdict, number>;
  readonly failures: string[];
}

const kinds = ["github", "journal"] as const;
const batchSize = 200;

async function folders(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const kind of kinds)
    for (const entry of await readdir(join(directory, kind), {
      withFileTypes: true,
    }).catch(() => []))
      if (entry.isDirectory()) found.push(`${kind}/${entry.name}`);
  return found.filter((path) => !sharedRecordFolders.includes(path)).sort();
}

async function newestChange(folder: string): Promise<number> {
  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...(await storedFiles(folder)).map((file) => file.changedAt),
  );
}

async function startedRecord(folder: string): Promise<unknown> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(folder, "started.json"), "utf8"),
    );
    return value;
  } catch {
    return undefined;
  }
}

async function examined(directory: string, path: string): Promise<Examined> {
  const folder = join(directory, path);
  try {
    return {
      path,
      started: await startedRecord(folder),
      changedAt: await newestChange(folder),
    };
  } catch {
    return { path, started: undefined, changedAt: Number.NaN };
  }
}

export function archiveFolder(
  settings: Pick<SweepSettings, "directory" | "retention">,
): string {
  return (
    settings.retention.archiveFolder ?? join(settings.directory, "archive")
  );
}

async function removed(settings: SweepSettings, path: string): Promise<void> {
  const source = join(settings.directory, path);
  if (settings.retention.action === "delete") {
    await rm(source, { recursive: true, force: true });
    return;
  }
  await archivedFolder(
    { source, target: join(archiveFolder(settings), path) },
    settings.files ?? nodeFiles,
  );
}

function countLine(action: RetentionSettings["action"], tally: Tally): string {
  const { counts, failures } = tally;
  const moved = action === "delete" ? "deleted" : "archived";
  const failed =
    failures.length === 0
      ? ""
      : `, failed ${String(failures.length)} (${failures[0] ?? ""})`;
  return `retention: ${moved} ${String(counts.due)}, kept ${String(counts.kept)}, skipped ${String(counts.skipped)} (active runs), unreadable ${String(counts.unreadable)}${failed}\n`;
}

async function unavailable(settings: SweepSettings): Promise<boolean> {
  if (settings.retention.action === "delete") return false;
  const reason = await archiveReady(archiveFolder(settings), {
    configured: settings.retention.archiveFolder !== null,
  });
  if (reason === undefined) return false;
  settings.log(
    `retention: archive folder not available (${reason}), moved nothing\n`,
  );
  return true;
}

async function handled(
  settings: SweepSettings,
  folder: { readonly path: string; readonly tally: Tally },
): Promise<void> {
  try {
    await removed(settings, folder.path);
    folder.tally.counts.due += 1;
  } catch (error) {
    folder.tally.failures.push(`${folder.path}: ${failureReason(error)}`);
  }
}

async function nextBatch(sweep: Sweep): Promise<readonly string[]> {
  const batch = batchAfter(await folders(sweep.settings.directory), {
    cursor: sweep.cursor,
    size: batchSize,
  });
  sweep.cursor = batch.at(-1) ?? "";
  return batch;
}

async function swept(sweep: Sweep): Promise<void> {
  const { settings } = sweep;
  const days = settings.retention.days;
  if (days === null || (await unavailable(settings))) return;
  const batch = await Promise.all(
    (await nextBatch(sweep)).map((path) => examined(settings.directory, path)),
  );
  const runIds = [
    ...new Set(batch.flatMap((folder) => folderRunId(folder.started) ?? [])),
  ];
  const runs = await settings.runs(runIds);
  const now = settings.now();
  const tally: Tally = {
    counts: { due: 0, kept: 0, skipped: 0, unreadable: 0 },
    failures: [],
  };
  for (const folder of batch) {
    const verdict = retentionVerdict(folder, { runs, now, days });
    if (verdict === "due")
      await handled(settings, { path: folder.path, tally });
    else tally.counts[verdict] += 1;
  }
  settings.log(countLine(settings.retention.action, tally));
}

export function recordSweep(settings: SweepSettings): RecordSweep {
  const sweep: Sweep = { settings, cursor: "" };
  return {
    pass: () =>
      swept(sweep).catch((error: unknown) => {
        settings.log(`retention: failed (${failureReason(error)})\n`);
      }),
  };
}

export async function recordRetention(
  settings: SweepSettings & {
    readonly intervalMilliseconds?: number;
    readonly bundles?: RecordSweep;
  },
): Promise<RetentionLoop> {
  const records = recordSweep(settings);
  const pass = async () => {
    await records.pass();
    await settings.bundles?.pass();
  };
  await pass();
  let running = Promise.resolve();
  const timer = setInterval(() => {
    running = running.then(pass);
  }, settings.intervalMilliseconds ?? retentionIntervalMilliseconds);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}

export function authorityRuns(
  ports: Pick<HostPorts, "runWait">,
): SweepSettings["runs"] {
  return async (runIds) => {
    const found: [string, StoredRun][] = [];
    for (const runId of runIds) {
      const target = await ports.runWait?.target(runId);
      if (target === undefined) continue;
      found.push([runId, { status: target.status, endedAt: target.endedAt }]);
    }
    return Object.fromEntries(found);
  };
}
