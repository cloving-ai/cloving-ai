import { execFile } from "node:child_process";
import {
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  isRestartRequest,
  newestRestart,
  restartFiles,
  type RestartMark,
  type RestartRequest,
} from "../src/restart-request.ts";
import { atGap, workInProgress } from "../src/work-gap.ts";
import { hostWorkReads } from "./self-update-host.ts";

export interface RestartWatch {
  readonly directory: string;
  readonly runtime: string;
  readonly milliseconds: number;
  readonly stopping: AbortSignal;
  readonly stop: () => Promise<void>;
}

function coded(error: unknown, code: string): boolean {
  if (error instanceof Error && "code" in error && error.code === code)
    return true;
  throw error;
}

function absent(error: unknown): string {
  coded(error, "ENOENT");
  return "";
}

function noNames(error: unknown): readonly string[] {
  coded(error, "ENOENT");
  return [];
}

async function requestNames(directory: string): Promise<readonly string[]> {
  const names = await readdir(directory).catch(noNames);
  return names.filter(isRestartRequest);
}

async function pendingRestart(
  directory: string,
): Promise<RestartRequest | undefined> {
  return newestRestart(
    await Promise.all(
      (await requestNames(directory)).map(async (name) => ({
        name,
        text: await readFile(join(directory, name), "utf8").catch(absent),
      })),
    ),
  );
}

export async function claimedRestart(
  directory: string,
  checked: RestartRequest,
): Promise<RestartMark | undefined> {
  const moved = await rename(
    join(directory, checked.name),
    join(directory, restartFiles.claimed),
  ).then(
    () => true,
    (error: unknown) => !coded(error, "ENOENT"),
  );
  return moved ? checked.mark : undefined;
}

async function due(watch: RestartWatch, mark: RestartMark): Promise<boolean> {
  if (mark.at === "now") return true;
  const work = await workInProgress(
    hostWorkReads({
      directory: watch.directory,
      runtimeDirectory: watch.runtime,
      signal: watch.stopping,
    }),
  );
  return atGap(work);
}

export async function clearedRestart(directory: string): Promise<void> {
  const names = [...(await requestNames(directory)), restartFiles.claimed];
  await Promise.all(
    names.map((name) => rm(join(directory, name), { force: true })),
  );
}

export async function restartWatch(
  watch: RestartWatch,
): Promise<number | undefined> {
  for (;;) {
    const waited = await delay(watch.milliseconds, true, {
      signal: watch.stopping,
    }).catch(() => false);
    if (!waited) return undefined;
    const request = await pendingRestart(watch.directory).catch(
      () => undefined,
    );
    if (request === undefined) continue;
    if (!(await due(watch, request.mark).catch(() => false))) continue;
    const claimed = await claimedRestart(watch.directory, request).catch(
      () => undefined,
    );
    if (claimed === undefined) continue;
    await watch.stop();
    if (claimed.resumeQueue)
      await writeFile(join(watch.directory, "resume-queue"), "", {
        mode: 0o600,
      });
    if (claimed.settings === "files")
      await writeFile(join(watch.directory, restartFiles.settings), "files", {
        mode: 0o600,
      });
    await clearedRestart(watch.directory);
    return 75;
  }
}

export async function productCommit(checkout: string): Promise<string | null> {
  try {
    const shown = await promisify(execFile)(
      "git",
      ["-C", checkout, "rev-parse", "--show-toplevel", "HEAD"],
      { encoding: "utf8" },
    );
    const [top = "", commit = ""] = shown.stdout.trim().split("\n");
    return (await realpath(top)) === (await realpath(checkout)) ? commit : null;
  } catch {
    return null;
  }
}
