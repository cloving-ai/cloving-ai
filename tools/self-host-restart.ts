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
  claimText,
  isRestartRequest,
  newestRestart,
  restartFailureText,
  restartFiles,
  restartText,
  serialCalls,
  type RestartMark,
  type RestartProblem,
  type RestartRequest,
} from "../src/restart-request.ts";
import { gapLines, heldWork, workInProgress } from "../src/work-gap.ts";
import {
  checkedBuild,
  forgottenBuild,
  rememberedBuild,
} from "./restart-build.ts";
import {
  checkoutCommands,
  recoveredCheckout,
  updatedCheckout,
  type UpdatePlan,
} from "./restart-update.ts";
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
  readonly stopChildren: () => Promise<readonly string[]>;
  readonly resumeChildren: () => void;
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

async function replaced(
  directory: string,
  file: { readonly name: string; readonly text: string },
): Promise<void> {
  const temporary = join(directory, `restart-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, file.text, { mode: 0o600 });
    await rename(temporary, join(directory, file.name));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function claimedRestart(
  directory: string,
  checked: RestartRequest,
): Promise<RestartMark | undefined> {
  const request = join(directory, checked.name);
  const claim = join(directory, restartFiles.claimed);
  const moved = await rename(request, claim).then(
    () => true,
    (error: unknown) => !coded(error, "ENOENT"),
  );
  if (!moved) return undefined;
  try {
    await replaced(directory, {
      name: restartFiles.claimed,
      text: claimText(checked.mark, process.pid),
    });
  } catch (error) {
    await rename(claim, request);
    throw error;
  }
  return checked.mark;
}

async function waitingWork(
  watch: RestartWatch,
  mark: RestartMark,
): Promise<readonly string[]> {
  if (mark.at === "now") return [];
  const reads = hostWorkReads({
    directory: watch.directory,
    runtimeDirectory: watch.runtime,
    signal: watch.stopping,
  });
  if (mark.at === "keep") return heldWork(reads);
  return gapLines(await workInProgress(reads));
}

async function expired(
  watch: RestartWatch,
  waiting: {
    readonly request: RestartRequest;
    readonly work: readonly string[] | null;
  },
): Promise<void> {
  const { mark, name } = waiting.request;
  if (mark.deadline === undefined || Date.now() < mark.deadline) return;
  const output =
    waiting.work?.join("\n") ?? "The service did not list its active runs.";
  const unsaved = await failureNoted(watch, {
    mark,
    failure: { code: "restart-deadline", step: "wait", output },
  }).then(
    () => undefined,
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
  await rm(join(watch.directory, name), { force: true });
  process.stderr.write(`Restart cancelled: restart-deadline\n${output}\n`);
  if (unsaved !== undefined)
    process.stderr.write(
      `The note of the cancelled restart was not saved: ${unsaved}\n`,
    );
}

async function failureNoted(
  watch: RestartWatch,
  noted: { readonly mark: RestartMark; readonly failure: RestartProblem },
): Promise<void> {
  const { commandId, requestedAt } = noted.mark;
  await replaced(watch.directory, {
    name: restartFiles.failure,
    text: restartFailureText({ commandId, requestedAt, ...noted.failure }),
  });
}

const updateHeadings = {
  skipped: "Restart update skipped: the checkout has local changes.",
  failed: "Restart update failed at step",
} as const;

async function updateNoted(
  watch: RestartWatch,
  mark: RestartMark,
): Promise<void> {
  if (mark.update !== true) return;
  const outcome = await updatedCheckout(checkoutCommands(watch));
  if (outcome.kind === "updated") return rememberedBuild(watch.checkout);
  if (outcome.kind !== "skipped") await forgottenBuild(watch.checkout);
  const { step, output } = outcome;
  const heading =
    outcome.kind === "skipped"
      ? updateHeadings.skipped
      : `${updateHeadings.failed} ${step}.`;
  process.stderr.write(`${heading}\n${output}\n`);
  await failureNoted(watch, {
    mark,
    failure: { code: `restart-update-${outcome.kind}`, step, output },
  });
  if (outcome.kind === "broken") await rebuiltOld(watch, outcome.plan);
}

async function rebuiltOld(
  watch: RestartWatch,
  plan: UpdatePlan,
): Promise<void> {
  const commands = checkoutCommands(watch);
  for (;;) {
    const waited = await delay(watch.milliseconds, true, {
      signal: watch.stopping,
    }).catch(() => false);
    if (!waited) return;
    const rebuilt = await recoveredCheckout(commands, plan);
    if (rebuilt.kind === "done") return;
    process.stderr.write(
      `The old commit ${plan.head} did not build again at step ${rebuilt.step}. The service tries again before the restart.\n${rebuilt.output}\n`,
    );
  }
}

export async function clearedRestart(directory: string): Promise<void> {
  const names = [...(await requestNames(directory)), restartFiles.claimed];
  await Promise.all(
    names.map((name) => rm(join(directory, name), { force: true })),
  );
}

function stopSignalled(watch: RestartWatch): boolean {
  return watch.stopping.aborted;
}

async function refusal(
  watch: RestartWatch,
  noted: { readonly mark: RestartMark; readonly failure: RestartProblem },
): Promise<true> {
  const { code, output } = noted.failure;
  process.stderr.write(`Restart refused: ${code}\n${output}\n`);
  await failureNoted(watch, noted);
  await rm(join(watch.directory, restartFiles.claimed), { force: true });
  return true;
}

async function refused(
  watch: RestartWatch,
  mark: RestartMark,
): Promise<boolean> {
  if ((await productCommit(watch.checkout)) === null) return false;
  const output = await checkedBuild(watch.checkout, checkoutCommands(watch));
  if (output === undefined || stopSignalled(watch)) return stopSignalled(watch);
  return refusal(watch, {
    mark,
    failure: { code: "restart-build-failed", step: "build", output },
  });
}

async function childrenAlive(
  watch: RestartWatch,
  mark: RestartMark,
): Promise<boolean> {
  const alive = await watch.stopChildren();
  if (alive.length === 0) return stopSignalled(watch);
  return refusal(watch, {
    mark,
    failure: {
      code: "restart-children-alive",
      step: "stop",
      output: alive.join("\n"),
    },
  });
}

async function workStarted(
  watch: RestartWatch,
  mark: RestartMark,
): Promise<boolean> {
  const work = await waitingWork(watch, mark).catch(() => null);
  if (work !== null && work.length === 0) return false;
  await replaced(watch.directory, {
    name: `${restartFiles.request}${randomUUID()}`,
    text: restartText(mark),
  });
  await rm(join(watch.directory, restartFiles.claimed), { force: true });
  watch.resumeChildren();
  const output = work ?? ["The service did not list its work."];
  process.stderr.write(
    `Restart waits: work started before the stop.\n${output.join("\n")}\n`,
  );
  return true;
}

async function restarted(
  watch: RestartWatch,
  claimed: RestartMark,
): Promise<number | undefined> {
  if (stopSignalled(watch) || (await refused(watch, claimed))) return undefined;
  if (await childrenAlive(watch, claimed)) return undefined;
  if (await workStarted(watch, claimed)) return undefined;
  await watch.stop();
  if (stopSignalled(watch)) return undefined;
  await updateNoted(watch, claimed);
  if (stopSignalled(watch)) return undefined;
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
    const work = await waitingWork(watch, request.mark).catch(() => null);
    if (work === null || work.length > 0) {
      await expired(watch, { request, work }).catch(() => undefined);
      continue;
    }
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
