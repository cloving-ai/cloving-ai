import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { turnEnvironment } from "./claude-turn.ts";
import { commandLimits } from "../command-settings.ts";
import { isInstant } from "../authority/instants.ts";

export interface CommandStart {
  readonly command: readonly string[];
  readonly directory: string;
  readonly folder: string;
  readonly payload: string;
  readonly runId: string;
  readonly operationId: string;
  readonly seconds: number;
  readonly deadline?: string;
}

export interface CommandEnd {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly durationMilliseconds: number;
  readonly reason?: string;
}

export interface RunningCommand {
  readonly ended: Promise<CommandEnd>;
  readonly stop: () => void;
}

export interface CommandClock {
  readonly now: () => number;
  readonly timer: (wait: {
    readonly milliseconds: number;
    readonly expired: () => void;
  }) => () => void;
}

const commandClock: CommandClock = {
  now: () => Date.now(),
  timer: (wait) => {
    const timer = setTimeout(wait.expired, wait.milliseconds);
    return () => {
      clearTimeout(timer);
    };
  },
};

function boundedOutput(
  stream: NodeJS.ReadableStream,
  options: {
    readonly bytes: number;
    readonly receive: (chunk: Buffer) => void;
    readonly exceeded: () => void;
  },
): void {
  let received = 0;
  stream.on("data", (chunk: Buffer) => {
    const kept = chunk.subarray(0, Math.max(0, options.bytes - received));
    received += chunk.length;
    if (kept.length > 0) options.receive(kept);
    if (received > options.bytes) options.exceeded();
  });
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    child.kill("SIGKILL");
  }
}

function spawnCommand(start: CommandStart, configuration: string) {
  const [executable = "", ...argumentsList] = start.command;
  return spawn(executable, argumentsList, {
    cwd: start.directory,
    env: {
      ...turnEnvironment(configuration, { ...start, prompt: start.payload }),
      CLOVING_RUN_ID: start.runId,
      CLOVING_OPERATION_ID: start.operationId,
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}

function writeStderr(descriptor: number, chunk: Buffer): boolean {
  try {
    writeSync(descriptor, chunk);
    return true;
  } catch {
    return false;
  }
}

function captureOutput(
  running: {
    readonly child: ReturnType<typeof spawnCommand>;
    readonly stderr: number;
  },
  output: {
    readonly stdout: Buffer[];
    readonly fail: (reason: string) => void;
  },
): void {
  const exceeded = (): void => {
    output.fail("command-output-limit");
  };
  boundedOutput(running.child.stdout, {
    bytes: commandLimits.stdoutBytes,
    receive: (chunk) => {
      output.stdout.push(chunk);
    },
    exceeded,
  });
  boundedOutput(running.child.stderr, {
    bytes: commandLimits.stderrBytes,
    receive: (chunk) => {
      if (!writeStderr(running.stderr, chunk)) output.fail("command-exit");
    },
    exceeded,
  });
}

function releaseCommand(resources: {
  readonly stderr: number | undefined;
  readonly configuration: string;
}): void {
  try {
    if (resources.stderr !== undefined) closeSync(resources.stderr);
  } finally {
    rmSync(resources.configuration, { recursive: true, force: true });
  }
}

function prepareCommand(
  start: CommandStart,
  clock: CommandClock,
):
  | { readonly reason: string }
  | {
      readonly child: ReturnType<typeof spawnCommand>;
      readonly stderr: number;
      readonly configuration: string;
    } {
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  let stderr: number | undefined;
  let child: ReturnType<typeof spawnCommand> | undefined;
  try {
    stderr = openSync(join(start.folder, "command.stderr.log"), "w", 0o600);
    const reason = deadlineRefusal(start, clock);
    if (reason !== undefined) return { reason };
    child = spawnCommand(start, configuration);
    return { child, stderr, configuration };
  } finally {
    if (child === undefined) releaseCommand({ stderr, configuration });
  }
}

function commandTimer(
  start: CommandStart,
  timing: {
    readonly clock: CommandClock;
    readonly fail: (reason: string) => void;
  },
) {
  const remaining =
    start.deadline === undefined
      ? Infinity
      : Date.parse(start.deadline) - timing.clock.now();
  const execution = start.seconds * 1000;
  return timing.clock.timer({
    expired: () => {
      timing.fail(
        remaining <= execution ? "command-wait-timeout" : "command-timeout",
      );
    },
    milliseconds: Math.min(execution, remaining),
  });
}

function refusedCommand(reason: string): RunningCommand {
  return {
    ended: Promise.resolve({
      stdout: "",
      exitCode: null,
      durationMilliseconds: 0,
      reason,
    }),
    stop: () => undefined,
  };
}

function deadlineRefusal(
  start: CommandStart,
  clock: CommandClock,
): string | undefined {
  if (start.deadline !== undefined && !isInstant(start.deadline))
    return "invalid-command-deadline";
  if (start.deadline !== undefined && Date.parse(start.deadline) <= clock.now())
    return "command-wait-timeout";
  return undefined;
}

export function startCommand(
  start: CommandStart,
  clock: CommandClock = commandClock,
): RunningCommand {
  const refusal = deadlineRefusal(start, clock);
  if (refusal !== undefined) return refusedCommand(refusal);
  const began = performance.now();
  const prepared = prepareCommand(start, clock);
  if ("reason" in prepared) return refusedCommand(prepared.reason);
  const { child, stderr, configuration } = prepared;
  const stdout: Buffer[] = [];
  const closed = Promise.withResolvers<number | null>();
  let reason: string | undefined;
  const fail = (failure: string): void => {
    reason ??= failure;
    killGroup(child);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    closed.resolve(child.exitCode);
  };
  captureOutput(prepared, { stdout, fail });
  const cancelTimer = commandTimer(start, { clock, fail });
  child.stdin.on("error", () => undefined);
  child.stdin.end(start.payload);
  child.once("error", () => undefined);
  child.once("close", closed.resolve);
  const ended = closed.promise.then((exitCode) => {
    cancelTimer();
    releaseCommand({ stderr, configuration });
    reason ??= deadlineRefusal(start, clock);
    reason ??= exitCode === 0 ? undefined : "command-exit";
    return {
      stdout: Buffer.concat(stdout).toString("utf8"),
      exitCode,
      durationMilliseconds: Math.round(performance.now() - began),
      ...(reason === undefined ? {} : { reason }),
    };
  });
  return {
    ended,
    stop: () => {
      fail("command-exit");
    },
  };
}
