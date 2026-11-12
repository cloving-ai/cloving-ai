import type { ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { turnEnvironment } from "./claude-turn.ts";
import { commandLimits } from "../command-settings.ts";
import { isInstant } from "../authority/instants.ts";
import type { TurnLaunch } from "../turn-launch.ts";
import {
  attachedProcess,
  inputDescriptor,
  launchedProcess,
  launchMarker,
  type DetachedProcess,
  type Ending,
  type LaunchedProcess,
  type LauncherLimits,
  type LauncherStart,
  type Watch,
} from "./detached-process.ts";

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

export interface KeptCommand extends Pick<CommandStart, "folder" | "deadline"> {
  readonly launch: TurnLaunch;
  readonly startedAt: number;
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
  readonly launch: Promise<TurnLaunch | null>;
  readonly release: () => void;
}

export interface CommandClock {
  readonly now: () => number;
  readonly timer: (wait: {
    readonly milliseconds: number;
    readonly expired: () => void;
  }) => () => void;
}

interface Judged {
  readonly at: number;
  readonly durationMilliseconds: number;
}

interface Following {
  readonly process: DetachedProcess;
  readonly stop: () => "stopped" | "stopping";
  readonly configuration: string;
  readonly judged: (ending: Ending | undefined) => Judged;
  readonly timer?: (fail: (reason: string) => void) => () => void;
  readonly launch: Promise<TurnLaunch | null>;
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

function commandFiles(folder: string) {
  return {
    output: join(folder, "command.stdout"),
    errors: join(folder, "command.stderr.log"),
    exit: join(folder, "command.exit.json"),
    input: join(folder, "command.payload"),
  };
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function leadingText(path: string): string {
  const buffer = Buffer.alloc(commandLimits.stdoutBytes);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function commandOutput(folder: string): {
  readonly stdout: string;
  readonly reason?: string;
} {
  const files = commandFiles(folder);
  const over =
    size(files.output) > commandLimits.stdoutBytes ||
    size(files.errors) > commandLimits.stderrBytes;
  if (size(files.errors) > commandLimits.stderrBytes)
    truncateSync(files.errors, commandLimits.stderrBytes);
  const stdout = leadingText(files.output);
  return over ? { stdout, reason: "command-output-limit" } : { stdout };
}

function stopLaunched(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    child.kill("SIGKILL");
  }
}

function commandEnvironment(
  start: CommandStart,
  configuration: string,
): NodeJS.ProcessEnv {
  return {
    ...turnEnvironment(configuration, {
      ...start,
      prompt: start.payload,
      variables: "inherit",
    }),
    CLOVING_RUN_ID: start.runId,
    CLOVING_OPERATION_ID: start.operationId,
  };
}

function closedAll(descriptors: readonly number[]): void {
  for (const descriptor of descriptors) closeSync(descriptor);
}

function journalFiles(
  start: CommandStart,
  clock: CommandClock,
):
  | { readonly reason: string }
  | { readonly descriptors: LauncherStart["descriptors"] } {
  const files = commandFiles(start.folder);
  const errors = openSync(files.errors, "w", 0o600);
  const reason = deadlineRefusal(start, clock.now());
  if (reason !== undefined) {
    closeSync(errors);
    return { reason };
  }
  const opened = [errors];
  try {
    const output = openSync(files.output, "w", 0o600);
    opened.push(output);
    const input = inputDescriptor({ path: files.input, text: start.payload });
    return { descriptors: [input, output, errors] };
  } catch (error) {
    closedAll(opened);
    throw error;
  }
}

type Prepared =
  | { readonly reason: string }
  | { readonly process: LaunchedProcess; readonly configuration: string };

function launchedCommand(
  start: CommandStart,
  setup: { readonly clock: CommandClock; readonly configuration: string },
): Prepared {
  const opened = journalFiles(start, setup.clock);
  if ("reason" in opened) return opened;
  const [executable = "", ...argumentsList] = start.command;
  const files = commandFiles(start.folder);
  const process = launchedProcess({
    executable,
    arguments: argumentsList,
    environment: commandEnvironment(start, setup.configuration),
    directory: start.directory,
    descriptors: opened.descriptors,
    marker: launchMarker(start.folder, {
      output: files.output,
      offset: 0,
      exit: files.exit,
      configuration: setup.configuration,
    }),
    limits: {
      ...timeLimit(start, setup.clock),
      outputBytes: commandLimits.stdoutBytes,
      errorBytes: commandLimits.stderrBytes,
    },
  });
  return { process, configuration: setup.configuration };
}

function prepareCommand(start: CommandStart, clock: CommandClock): Prepared {
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  let prepared: Prepared | undefined;
  try {
    prepared = launchedCommand(start, { clock, configuration });
    return prepared;
  } finally {
    if (prepared === undefined || "reason" in prepared)
      rmSync(configuration, { recursive: true, force: true });
  }
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
    launch: Promise.resolve(null),
    release: () => undefined,
  };
}

function deadlineRefusal(
  start: Pick<CommandStart, "deadline">,
  at: number,
): string | undefined {
  if (start.deadline !== undefined && !isInstant(start.deadline))
    return "invalid-command-deadline";
  if (start.deadline !== undefined && Date.parse(start.deadline) <= at)
    return "command-wait-timeout";
  return undefined;
}

function timeLimit(
  start: Pick<CommandStart, "seconds" | "deadline">,
  clock: CommandClock,
): Pick<LauncherLimits, "milliseconds" | "reason"> {
  const remaining =
    start.deadline === undefined
      ? Infinity
      : Date.parse(start.deadline) - clock.now();
  const execution = start.seconds * 1000;
  return {
    reason: remaining <= execution ? "command-wait-timeout" : "command-timeout",
    milliseconds: Math.max(0, Math.min(execution, remaining)),
  };
}

function commandEnd(
  start: Pick<CommandStart, "folder" | "deadline">,
  finish: {
    readonly ending: Ending | undefined;
    readonly judged: Judged;
    readonly reason: string | undefined;
  },
): CommandEnd {
  const output = commandOutput(start.folder);
  const exitCode = finish.ending?.exitCode ?? null;
  const reason =
    finish.reason ??
    finish.ending?.reason ??
    output.reason ??
    deadlineRefusal(start, finish.judged.at) ??
    (exitCode === 0 ? undefined : "command-exit");
  return {
    stdout: output.stdout,
    exitCode,
    durationMilliseconds: finish.judged.durationMilliseconds,
    ...(reason === undefined ? {} : { reason }),
  };
}

function followedCommand(
  start: Pick<CommandStart, "folder" | "deadline">,
  following: Following,
): RunningCommand {
  let reason: string | undefined;
  const watching = new AbortController();
  const settled = Promise.withResolvers<Watch | "failed">();
  const fail = (failure = "command-exit"): void => {
    reason ??= failure;
    if (following.stop() === "stopped") settled.resolve("failed");
  };
  following.process.ending(watching.signal).then(settled.resolve, () => {
    settled.resolve("gone");
  });
  const cancelTimer = following.timer?.(fail) ?? (() => undefined);
  return {
    ended: settled.promise.then((watch) => {
      cancelTimer();
      if (watch === "released") throw new Error("command-released");
      rmSync(following.configuration, { recursive: true, force: true });
      const ending = typeof watch === "object" ? watch : undefined;
      return commandEnd(start, {
        ending,
        judged: following.judged(ending),
        reason,
      });
    }),
    stop: fail,
    launch: following.launch,
    release: () => {
      watching.abort();
    },
  };
}

export function startCommand(
  start: CommandStart,
  clock: CommandClock = commandClock,
): RunningCommand {
  const reason = deadlineRefusal(start, clock.now());
  if (reason !== undefined) return refusedCommand(reason);
  const prepared = prepareCommand(start, clock);
  if ("reason" in prepared) return refusedCommand(prepared.reason);
  const { process: launched, configuration } = prepared;
  const output = commandFiles(start.folder).output;
  const began = performance.now();
  return followedCommand(start, {
    process: launched,
    stop: () => {
      stopLaunched(launched.child);
      return "stopped";
    },
    configuration,
    judged: () => ({
      at: clock.now(),
      durationMilliseconds: Math.round(performance.now() - began),
    }),
    timer: (fail) => {
      const limit = timeLimit(start, clock);
      return clock.timer({
        milliseconds: limit.milliseconds,
        expired: () => {
          fail(limit.reason);
        },
      });
    },
    launch: launched.launch.then((recorded) =>
      recorded === null
        ? null
        : { ...recorded, output, offset: 0, configuration },
    ),
  });
}

export function attachedCommand(kept: KeptCommand): RunningCommand {
  const process = attachedProcess(kept.launch);
  return followedCommand(kept, {
    process,
    stop: () => {
      process.signal("SIGKILL");
      return "stopping";
    },
    configuration: kept.launch.configuration,
    judged: (ending) => {
      const at = ending?.endedAt ?? Date.now();
      return {
        at,
        durationMilliseconds: Math.max(0, Math.round(at - kept.startedAt)),
      };
    },
    launch: Promise.resolve(kept.launch),
  });
}
