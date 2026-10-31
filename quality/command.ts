export interface TestShard {
  readonly index: number;
  readonly count: number;
}

export function parseTestShard(
  value: string | undefined,
): TestShard | undefined {
  if (value === undefined) return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index > count
  )
    throw new Error(
      "CLOVING_TEST_SHARD must be an index/count from 1 to count",
    );
  return { index, count };
}

export function parseCheckTimeFactor(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^[1-9]$/.test(value))
    throw new Error(
      "CLOVING_CHECK_TIME_FACTOR must be a whole number from 1 to 9",
    );
  return Number(value);
}

export interface CheckCommand {
  readonly check?: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly directory: string;
  readonly timeoutMilliseconds: number;
  readonly acceptedExitCodes?: readonly number[];
  readonly coverageDirectory?: string;
  readonly homeDirectory?: string;
}

export interface CheckTiming {
  readonly check: string;
  readonly elapsedMilliseconds: number;
  readonly timeoutMilliseconds: number;
}

export interface CommandOptions {
  readonly clock?: () => number;
  readonly timings?: CheckTiming[];
}

export function checkTimeWarnings(timings: readonly CheckTiming[]): string[] {
  return timings
    .filter(
      (entry) => entry.elapsedMilliseconds > entry.timeoutMilliseconds * 0.8,
    )
    .map(
      (entry) =>
        `${entry.check} used ${String(entry.elapsedMilliseconds / 1000)} s of ${String(entry.timeoutMilliseconds / 1000)} s (${String(Math.round((entry.elapsedMilliseconds / entry.timeoutMilliseconds) * 100))} percent)`,
    );
}

export function runCommand(
  command: CheckCommand,
  options: CommandOptions = {},
): string {
  validateTimeout(command);
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  try {
    return executeCommand(command);
  } finally {
    options.timings?.push({
      check: command.check ?? command.executable,
      elapsedMilliseconds: Math.round(clock() - started),
      timeoutMilliseconds: command.timeoutMilliseconds,
    });
  }
}

function executeCommand(command: CheckCommand): string {
  const result = spawnSync(
    command.executable,
    command.arguments,
    spawnOptions(command),
  );
  return commandOutput(command, result);
}

function validateTimeout(command: CheckCommand): void {
  if (
    !Number.isFinite(command.timeoutMilliseconds) ||
    command.timeoutMilliseconds <= 0
  )
    throw new Error("Check command requires a finite positive timeout");
}

function commandOutput(command: CheckCommand, result: CommandResult): string {
  if (result.error)
    throw new Error(
      `Check execution failed: ${command.check ?? command.executable} (limit ${String(command.timeoutMilliseconds)} ms)`,
      {
        cause: result.error,
      },
    );
  if (
    result.status === null ||
    !(command.acceptedExitCodes ?? [0]).includes(result.status)
  )
    throw new Error(
      `Check exit ${String(result.status)}: ${command.executable}\n${result.stderr}\n${result.stdout}`,
    );
  return result.stdout;
}

function spawnOptions(
  command: CheckCommand,
): SpawnSyncOptionsWithStringEncoding {
  return {
    cwd: command.directory,
    encoding: "utf8",
    timeout: command.timeoutMilliseconds,
    maxBuffer: 8 * 1024 * 1024,
    env: commandEnvironment(command),
  };
}

function commandEnvironment(command: CheckCommand): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    CLOVING_CHECK_TIME_FACTOR: process.env["CLOVING_CHECK_TIME_FACTOR"],
    CLOVING_TEST_CONCURRENCY: process.env["CLOVING_TEST_CONCURRENCY"],
    TZ: "UTC",
    CI: "true",
    NODE_DISABLE_COMPILE_CACHE: "1",
    ...(command.homeDirectory ? { HOME: command.homeDirectory } : {}),
    ...(command.coverageDirectory
      ? { NODE_V8_COVERAGE: command.coverageDirectory }
      : {}),
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error | undefined;
}

export async function runSupervisedCommand(
  command: CheckCommand,
  options: CommandOptions = {},
): Promise<string> {
  validateTimeout(command);
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  try {
    return commandOutput(command, await superviseCommand(command));
  } finally {
    options.timings?.push({
      check: command.check ?? command.executable,
      elapsedMilliseconds: Math.round(clock() - started),
      timeoutMilliseconds: command.timeoutMilliseconds,
    });
  }
}

async function superviseCommand(command: CheckCommand): Promise<CommandResult> {
  const child = spawn(command.executable, command.arguments, {
    cwd: command.directory,
    env: commandEnvironment(command),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result: CommandResult = { stdout: "", stderr: "", status: null };
  const stop = (error: Error): void => {
    result.error ??= error;
    if (child.pid) killVerificationGroup(child.pid);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const interrupt = (): void => {
    process.exitCode = 1;
    stop(new Error("Check interrupted"));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const timeout = setTimeout(() => {
    stop(new Error("Check timed out"));
  }, command.timeoutMilliseconds);
  collectOutput(child, { result, stop });
  try {
    await new Promise<void>((resolve) => {
      child.once("error", (error) => {
        result.error ??= error;
      });
      child.once("close", (status) => {
        result.status = status;
        resolve();
      });
    });
    return result;
  } finally {
    clearTimeout(timeout);
    try {
      if (child.pid) await stopVerificationGroup(child.pid);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}

function collectOutput(
  child: ChildProcessByStdio<null, Readable, Readable>,
  capture: {
    readonly result: CommandResult;
    readonly stop: (error: Error) => void;
  },
): void {
  let bytes = 0;
  for (const channel of ["stdout", "stderr"] as const) {
    child[channel].setEncoding("utf8");
    child[channel].on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 8 * 1024 * 1024) {
        capture.stop(new Error("Check output exceeded maxBuffer"));
        return;
      }
      capture.result[channel] += data;
    });
  }
}
import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import type { Readable } from "node:stream";
import {
  killVerificationGroup,
  stopVerificationGroup,
} from "./verification-process-group.ts";
