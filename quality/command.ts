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
  if (
    !Number.isFinite(command.timeoutMilliseconds) ||
    command.timeoutMilliseconds <= 0
  )
    throw new Error("Check command requires a finite positive timeout");
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
  const result = spawnSync(command.executable, command.arguments, {
    cwd: command.directory,
    encoding: "utf8",
    timeout: command.timeoutMilliseconds,
    maxBuffer: 8 * 1024 * 1024,
    env: {
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
    },
  });
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
import { spawnSync } from "node:child_process";
