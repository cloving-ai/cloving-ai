import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { turnEnvironment } from "./claude-turn.ts";
import { commandLimits } from "../command-settings.ts";

export interface CommandStart {
  readonly command: readonly string[];
  readonly directory: string;
  readonly folder: string;
  readonly payload: string;
  readonly runId: string;
  readonly operationId: string;
  readonly seconds: number;
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

export function startCommand(start: CommandStart): RunningCommand {
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  const began = performance.now();
  const child = spawnCommand(start, configuration);
  const stdout: Buffer[] = [];
  const stderr = openSync(join(start.folder, "command.stderr.log"), "w", 0o600);
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
  const exceeded = (): void => {
    fail("command-output-limit");
  };
  boundedOutput(child.stdout, {
    bytes: commandLimits.stdoutBytes,
    receive: (chunk) => {
      stdout.push(chunk);
    },
    exceeded,
  });
  boundedOutput(child.stderr, {
    bytes: commandLimits.stderrBytes,
    receive: (chunk) => {
      writeSync(stderr, chunk);
    },
    exceeded,
  });
  const timer = setTimeout(() => {
    fail("command-timeout");
  }, start.seconds * 1000);
  child.stdin.on("error", () => undefined);
  child.stdin.end(start.payload);
  child.once("error", () => undefined);
  child.once("close", closed.resolve);
  const ended = closed.promise.then((exitCode) => {
    clearTimeout(timer);
    closeSync(stderr);
    rmSync(configuration, { recursive: true, force: true });
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
