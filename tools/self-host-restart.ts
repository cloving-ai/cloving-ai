import { execFile } from "node:child_process";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { restartMark, type RestartMark } from "../src/restart-request.ts";
import { atGap, workInProgress } from "../src/work-gap.ts";
import { hostWorkReads } from "./self-update-host.ts";

export interface RestartWatch {
  readonly directory: string;
  readonly runtime: string;
  readonly milliseconds: number;
  readonly stopping: AbortSignal;
  readonly stop: () => Promise<void>;
}

function absent(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return "";
  throw error;
}

async function pendingRestart(
  directory: string,
): Promise<RestartMark | undefined> {
  return restartMark(
    await readFile(join(directory, "pending-restart"), "utf8").catch(absent),
  );
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
  await rm(join(directory, "pending-restart"), { force: true });
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
    await watch.stop();
    if (mark.resumeQueue)
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
