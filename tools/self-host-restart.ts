import { execFile } from "node:child_process";
import {
  link,
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
  restartFiles,
  restartMark,
  sameRestart,
  type RestartMark,
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

async function pendingRestart(
  directory: string,
): Promise<RestartMark | undefined> {
  return restartMark(
    await readFile(join(directory, restartFiles.pending), "utf8").catch(absent),
  );
}

export async function returnedRestart(directory: string): Promise<void> {
  const claimed = join(directory, restartFiles.claimed);
  await link(claimed, join(directory, restartFiles.pending)).catch(
    (error: unknown) => coded(error, "EEXIST"),
  );
  await rm(claimed, { force: true });
}

export async function claimedRestart(
  directory: string,
  checked: RestartMark,
): Promise<RestartMark | undefined> {
  const claimed = join(directory, restartFiles.claimed);
  const moved = await rename(
    join(directory, restartFiles.pending),
    claimed,
  ).then(
    () => true,
    (error: unknown) => !coded(error, "ENOENT"),
  );
  if (!moved) return undefined;
  const held = restartMark(await readFile(claimed, "utf8"));
  if (held !== undefined && sameRestart(held, checked)) return held;
  await returnedRestart(directory);
  return undefined;
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
  await rm(join(directory, restartFiles.pending), { force: true });
  await rm(join(directory, restartFiles.claimed), { force: true });
}

export async function restartWatch(
  watch: RestartWatch,
): Promise<number | undefined> {
  for (;;) {
    const waited = await delay(watch.milliseconds, true, {
      signal: watch.stopping,
    }).catch(() => false);
    if (!waited) return undefined;
    const mark = await pendingRestart(watch.directory).catch(() => undefined);
    if (mark === undefined) continue;
    if (!(await due(watch, mark).catch(() => false))) continue;
    const claimed = await claimedRestart(watch.directory, mark).catch(
      () => undefined,
    );
    if (claimed === undefined) continue;
    await watch.stop();
    if (claimed.resumeQueue)
      await writeFile(join(watch.directory, "resume-queue"), "", {
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
