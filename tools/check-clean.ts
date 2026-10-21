import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants as systemConstants, tmpdir } from "node:os";
import { join } from "node:path";

interface CleanRun {
  identifier: number | undefined;
  signal: NodeJS.Signals | undefined;
  escalation: NodeJS.Timeout | undefined;
}

function signalGate(
  identifier: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (identifier === undefined) return;
  try {
    process.kill(-identifier, signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      throw error;
  }
}

function interrupt(run: CleanRun, signal: NodeJS.Signals): void {
  run.signal ??= signal;
  if (run.identifier === undefined) return;
  signalGate(run.identifier, signal);
  run.escalation ??= setTimeout(() => {
    signalGate(run.identifier, "SIGKILL");
  }, 5000);
}

function runGate(directory: string, run: CleanRun): Promise<number> {
  return new Promise((resolve, reject) => {
    const gate = spawn(process.execPath, ["tools/check-quality.ts"], {
      cwd: directory,
      stdio: "inherit",
      detached: true,
    });
    run.identifier = gate.pid;
    gate.once("error", reject);
    gate.once("close", (code, signal) => {
      resolve(
        code ?? (signal === null ? 1 : 128 + systemConstants.signals[signal]),
      );
    });
  });
}

async function prepareCopy(temporary: string): Promise<string> {
  const directory = join(temporary, "tree");
  const archive = join(temporary, "source.tar");
  await mkdir(directory);
  execFileSync("git", ["archive", "--format=tar", "--output", archive, "HEAD"]);
  execFileSync("tar", ["-xf", archive, "-C", directory]);
  await rm(archive);
  await cp(
    join(process.cwd(), "node_modules"),
    join(directory, "node_modules"),
    {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    },
  );
  return directory;
}

async function checkClean(): Promise<number> {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  if (status.length > 0)
    throw new Error(
      "check:clean refuses uncommitted changes. Commit your work before running check:clean.",
    );
  const run: CleanRun = {
    identifier: undefined,
    signal: undefined,
    escalation: undefined,
  };
  const onInterrupt = (): void => {
    interrupt(run, "SIGINT");
  };
  const onTerminate = (): void => {
    interrupt(run, "SIGTERM");
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(tmpdir(), "cloving-check-clean-"));
    const directory = await prepareCopy(temporary);
    const code = run.signal === undefined ? await runGate(directory, run) : 1;
    return run.signal === undefined
      ? code
      : 128 + systemConstants.signals[run.signal];
  } finally {
    clearTimeout(run.escalation);
    signalGate(run.identifier, "SIGKILL");
    run.identifier = undefined;
    try {
      if (temporary !== undefined)
        await rm(temporary, { recursive: true, force: true });
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  }
}

process.exitCode = await checkClean();
