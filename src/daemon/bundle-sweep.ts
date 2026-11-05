import {
  access,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  archivedFolder,
  archiveReady,
  failureReason,
  nodeFiles,
  sameContents,
  type RecordFiles,
} from "./record-archive.ts";
import { archiveFolder, type RecordSweep } from "./record-sweep.ts";
import {
  batchAfter,
  bundleDigestPattern,
  dueBundles,
  type RetentionSettings,
  type StoredBundle,
} from "../record-retention.ts";
import type { WorkflowReloadPort } from "../service/workflow-reload.ts";

export interface CurrentBundle {
  readonly digest: () => string | undefined;
  readonly exclusive: <Result>(task: () => Promise<Result>) => Promise<Result>;
  readonly reloading: (port: WorkflowReloadPort) => WorkflowReloadPort;
}

export interface BundleSweepSettings {
  readonly directory: string;
  readonly retention: RetentionSettings;
  readonly current: CurrentBundle;
  readonly pinned: () => Promise<readonly string[]>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly files?: RecordFiles;
}

interface StoredEntries {
  readonly bundles: readonly StoredBundle[];
  readonly interrupted: readonly string[];
}

interface BundleSweepState {
  readonly settings: BundleSweepSettings;
  cursor: string;
}

const removingPrefix = ".removing-";
const timesMarker = ".current-times";
const batchSize = 5;

function bundleStore(directory: string): string {
  return join(directory, "workflow-bundles");
}

async function stamped(
  directory: string,
  stamp: { readonly digest: string | undefined; readonly time: number },
): Promise<void> {
  const { digest, time } = stamp;
  if (digest === undefined || !bundleDigestPattern.test(digest)) return;
  const moment = new Date(time);
  await utimes(join(bundleStore(directory), digest), moment, moment).catch(
    (error: unknown) => {
      if (failureReason(error) !== "ENOENT") throw error;
    },
  );
}

export function currentBundle(settings: {
  readonly directory: string;
  readonly bundleDigest: string | undefined;
  readonly now: () => number;
  readonly log: (line: string) => void;
}): CurrentBundle {
  let digest = settings.bundleDigest;
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <Result>(task: () => Promise<Result>) => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };
  const switched = async (next: string) => {
    const time = settings.now();
    for (const stamp of [digest, next])
      await stamped(settings.directory, { digest: stamp, time }).catch(
        (error: unknown) => {
          settings.log(
            `retention: workflow bundle ${String(stamp)} not marked current (${failureReason(error)})\n`,
          );
        },
      );
    digest = next;
  };
  return {
    digest: () => digest,
    exclusive,
    reloading: (port) => () =>
      exclusive(async () => {
        const outcome = await port();
        if (outcome.kind === "reloaded") await switched(outcome.bundleDigest);
        return outcome;
      }),
  };
}

async function storedEntries(store: string): Promise<StoredEntries> {
  const entries = await readdir(store, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (failureReason(error) === "ENOENT") return [];
      throw error;
    },
  );
  const bundles: StoredBundle[] = [];
  const interrupted: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const digest = entry.name.slice(removingPrefix.length);
    if (
      entry.name.startsWith(removingPrefix) &&
      bundleDigestPattern.test(digest)
    )
      interrupted.push(entry.name);
    if (!bundleDigestPattern.test(entry.name)) continue;
    const found = await lstat(join(store, entry.name));
    bundles.push({ digest: entry.name, currentAt: found.mtimeMs });
  }
  return { bundles, interrupted };
}

async function archived(
  place: { readonly source: string; readonly target: string },
  files: RecordFiles,
): Promise<void> {
  try {
    await archivedFolder(place, files);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(failureReason(error))) throw error;
    if (!(await sameContents(place.source, place.target)))
      throw new Error("archive-copy-differs", { cause: error });
    await rm(place.source, { recursive: true, force: true });
  }
}

async function finished(
  settings: BundleSweepSettings,
  digest: string,
): Promise<void> {
  const source = join(
    bundleStore(settings.directory),
    `${removingPrefix}${digest}`,
  );
  if (settings.retention.action === "delete")
    await rm(source, { recursive: true, force: true });
  else
    await archived(
      {
        source,
        target: join(archiveFolder(settings), "workflow-bundles", digest),
      },
      settings.files ?? nodeFiles,
    );
  const moved = settings.retention.action === "delete" ? "deleted" : "archived";
  settings.log(`retention: ${moved} workflow bundle ${digest}\n`);
}

async function removed(
  settings: BundleSweepSettings,
  digest: string,
): Promise<void> {
  const store = bundleStore(settings.directory);
  await rm(join(store, ".history", digest), { recursive: true, force: true });
  await rename(join(store, digest), join(store, `${removingPrefix}${digest}`));
  await finished(settings, digest);
}

function removal(name: string): {
  readonly digest: string;
  readonly step: typeof removed;
} {
  if (!name.startsWith(removingPrefix)) return { digest: name, step: removed };
  return { digest: name.slice(removingPrefix.length), step: finished };
}

async function attempted(
  settings: BundleSweepSettings,
  removal: { readonly digest: string; readonly step: typeof removed },
): Promise<void> {
  try {
    await removal.step(settings, removal.digest);
  } catch (error) {
    settings.log(
      `retention: workflow bundle ${removal.digest} not removed (${failureReason(error)})\n`,
    );
  }
}

async function unavailable(settings: BundleSweepSettings): Promise<boolean> {
  if (settings.retention.action === "delete") return false;
  const reason = await archiveReady(archiveFolder(settings), {
    configured: settings.retention.archiveFolder !== null,
  });
  return reason !== undefined;
}

async function upgraded(
  settings: BundleSweepSettings,
  time: number,
): Promise<void> {
  const store = bundleStore(settings.directory);
  const marker = join(store, timesMarker);
  const marked = await access(marker).then(
    () => true,
    () => false,
  );
  if (marked) return;
  for (const bundle of (await storedEntries(store)).bundles)
    await stamped(settings.directory, { digest: bundle.digest, time });
  await mkdir(store, { recursive: true, mode: 0o700 });
  await writeFile(marker, "");
}

async function swept(sweep: BundleSweepState): Promise<void> {
  const { settings } = sweep;
  const { current, retention, directory } = settings;
  const time = settings.now();
  await stamped(directory, { digest: current.digest(), time });
  await upgraded(settings, time);
  if (retention.days === null || (await unavailable(settings))) return;
  const stored = await storedEntries(bundleStore(directory));
  const due = dueBundles(stored.bundles, {
    current: current.digest(),
    pinned: await settings.pinned(),
    now: time,
    days: retention.days,
  });
  const batch = batchAfter([...stored.interrupted, ...due].sort(), {
    cursor: sweep.cursor,
    size: batchSize,
  });
  sweep.cursor = batch.at(-1) ?? "";
  for (const name of batch) await attempted(settings, removal(name));
}

export function bundleSweep(settings: BundleSweepSettings): RecordSweep {
  const sweep: BundleSweepState = { settings, cursor: "" };
  return {
    pass: () =>
      settings.current
        .exclusive(() => swept(sweep))
        .catch((error: unknown) => {
          settings.log(
            `retention: workflow bundles failed (${failureReason(error)})\n`,
          );
        }),
  };
}

export function unfinishedPins(ports: {
  readonly state: () => Promise<{
    readonly runs: Readonly<
      Record<string, { readonly runId: string; readonly status: string }>
    >;
  }>;
  readonly manifest: (
    runId: string,
  ) => Promise<{ readonly bundleDigest?: string } | undefined>;
}): BundleSweepSettings["pinned"] {
  return async () => {
    const digests: string[] = [];
    for (const run of Object.values((await ports.state()).runs)) {
      if (["completed", "failed", "cancelled"].includes(run.status)) continue;
      const digest = (await ports.manifest(run.runId))?.bundleDigest;
      if (digest !== undefined) digests.push(digest);
    }
    return digests;
  };
}
