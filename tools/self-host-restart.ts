import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  restartFailureText,
  restartFiles,
  serialCalls,
  type RestartMark,
  type RestartRequest,
} from "../src/restart-request.ts";
import { atGap, workInProgress } from "../src/work-gap.ts";
import { checkoutCommands, updatedCheckout } from "./restart-update.ts";
import { hostWorkReads } from "./self-update-host.ts";

export type CheckoutLock = (
  work: () => Promise<number | undefined>,
) => Promise<number | undefined>;

export function checkoutLock(stopping: AbortController): CheckoutLock {
  const inOrder = serialCalls();
  return (work) =>
    inOrder(async () => {
      const status = await work();
      if (status !== undefined) stopping.abort();
      return status;
    });
}

export interface RestartWatch {
  readonly directory: string;
  readonly runtime: string;
  readonly checkout: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly milliseconds: number;
  readonly stopping: AbortSignal;
  readonly stop: () => Promise<void>;
  readonly exclusive: CheckoutLock;
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

async function updated(
  watch: RestartWatch,
  mark: RestartMark,
): Promise<boolean> {
  if (mark.update !== true) return true;
  const outcome = await updatedCheckout(checkoutCommands(watch));
  if (outcome.kind === "updated") return true;
  const temporary = join(watch.directory, `restart-${randomUUID()}.tmp`);
  const { step, output } = outcome;
  const { commandId, requestedAt } = mark;
  process.stderr.write(`Restart update failed at step ${step}.\n${output}\n`);
  await writeFile(
    temporary,
    restartFailureText({ commandId, requestedAt, step, output }),
    { mode: 0o600 },
  );
  await rename(temporary, join(watch.directory, restartFiles.failure));
  await rm(join(watch.directory, restartFiles.claimed), { force: true });
  return false;
}

export async function clearedRestart(directory: string): Promise<void> {
  const names = [
    ...(await requestNames(directory)),
    restartFiles.claimed,
    restartFiles.failure,
  ];
  await Promise.all(
    names.map((name) => rm(join(directory, name), { force: true })),
  );
}

async function restarted(
  watch: RestartWatch,
  claimed: RestartMark,
): Promise<number | undefined> {
  if (watch.stopping.aborted) return undefined;
  if (!(await updated(watch, claimed))) return undefined;
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
    const status = await watch.exclusive(() => restarted(watch, claimed));
    if (status !== undefined) return status;
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
