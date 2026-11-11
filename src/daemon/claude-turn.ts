import { turnCommand } from "./turn-command.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  accessSync,
  constants,
  createWriteStream,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { textOutput } from "./text-output.ts";
import {
  activityOutput,
  recordPrompt,
  type LaterAttempt,
} from "./turn-activity.ts";
import type { Worker, StreamResult } from "./claude-stream.ts";
import type { TurnProgress } from "./turn-stream.ts";
import { harnessReader } from "./harness-reader.ts";
import type { ResumeReason, RetryKind } from "../worker-usage.ts";
export { streamResult, capacityRefusal, retryKind } from "./claude-stream.ts";
export type { Worker, StreamResult } from "./claude-stream.ts";
export type { TurnProgress } from "./turn-stream.ts";
import { shellTurnScript } from "../agent-harness-shell.ts";
import { runnerProgram, type TurnRunner } from "../turn-runner.ts";
import { runnerLaunch, type RunnerLaunch } from "./turn-runner-spawn.ts";
import { attachedTurn, detachedTurn, type TurnExit } from "./detached-turn.ts";
import type { TurnLaunch } from "../turn-launch.ts";
import {
  githubTokens,
  passedVariables,
  type TurnVariables,
} from "../turn-environment.ts";

export interface TurnEnd {
  readonly retryKind?: RetryKind | null;
  readonly resumedAfter?: ResumeReason;
  readonly reason?: string;
  readonly detail?: string;
  readonly stopped?: boolean;
  readonly exitCode: number | null;
  readonly result: StreamResult | undefined;
}

export interface TurnStart {
  readonly progress?: (progress: TurnProgress) => Promise<void>;
  readonly resultBytes?: number;
  readonly output?: "text";
  readonly shell?: string;
  readonly worker?: Worker;
  readonly turnId?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly variables?: TurnVariables;
  readonly runner?: TurnRunner;
  readonly command: readonly string[];
  readonly directory: string;
  readonly folder: string;
  readonly laterAttempt?: LaterAttempt;
  readonly prompt: string;
  readonly release?: AbortSignal;
  readonly attach?: TurnLaunch;
}

export interface RunningTurn {
  readonly processId: number | null;
  readonly launch?: Promise<TurnLaunch | null>;
  readonly ended: Promise<TurnEnd>;
  readonly stop: (graceMilliseconds: number) => void;
}

export interface StartedTurn extends RunningTurn {
  readonly exited: Promise<TurnExit>;
}

export function succeeded(end: TurnEnd): boolean {
  return (
    end.reason === undefined &&
    end.exitCode === 0 &&
    end.result?.failed === false
  );
}

function ended(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((settle) => {
    stream.end(settle);
  });
}

export function turnEnvironment(
  configuration: string,
  start: TurnStart,
): NodeJS.ProcessEnv {
  const supplied = Object.entries(start.environment ?? {})
    .filter(([name]) => !githubTokens.includes(name))
    .map(([name, value]): [string, string] => [
      name,
      value.replaceAll("{turn}", start.turnId ?? ""),
    ]);
  const environment: NodeJS.ProcessEnv = {
    ...passedVariables(process.env, start),
    ...Object.fromEntries(supplied),
  };
  if (start.turnId !== undefined) environment["CLOVING_TURN_ID"] = start.turnId;
  environment["GH_CONFIG_DIR"] = configuration;
  if (start.worker === "opencode")
    environment["OPENCODE_PERMISSION"] = '{"*":"allow"}';
  return environment;
}

function shellCommand(
  start: TurnStart,
  turn: { readonly configuration: string; readonly parts: readonly string[] },
): readonly string[] {
  if (start.shell === undefined) return turn.parts;
  return [
    start.shell,
    "-l",
    "-i",
    "-c",
    shellTurnScript,
    "cloving-harness",
    turn.configuration,
    ...turn.parts,
  ];
}

function spawnTurn(start: TurnStart): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly configuration: string;
  readonly standardInput: string | undefined;
  readonly launch: RunnerLaunch;
} {
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  const { parts, standardInput } = turnCommand(start);
  const command = shellCommand(start, { configuration, parts });
  const environment = turnEnvironment(configuration, start);
  const launch = runnerLaunch(start, {
    command,
    environment,
    serviceEnvironment: process.env,
  });
  const [executable = "", ...fixed] = launch.command;
  try {
    const child = spawn(executable, fixed, {
      cwd: start.directory,
      env: launch.environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: start.shell !== undefined,
    });
    return { child, configuration, standardInput, launch };
  } catch (error) {
    rmSync(configuration, { recursive: true, force: true });
    throw error;
  }
}

function turnOutput(
  start: TurnStart,
  child: ChildProcessWithoutNullStreams,
): (
  exitCode: number | null,
  close: { readonly refused: boolean },
) => Promise<StreamResult | undefined> {
  const output = activityOutput(start);
  if (start.output === "text")
    return textOutput(child, { output, limit: start.resultBytes ?? 48_000 });
  const reader = harnessReader(
    {
      ...start,
      failed: () => {
        signalTurn({ child, start }, "SIGKILL");
      },
    },
    (text) => output.write(text),
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", reader.text);
  if (reader.error !== undefined) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", reader.error);
  }
  return async (exitCode, close) => {
    reader.finish({ exitCode, refused: close.refused });
    await ended(output);
    return reader.result();
  };
}

function signalTurn(
  turn: {
    readonly child: ChildProcessWithoutNullStreams;
    readonly start: TurnStart;
  },
  signal: NodeJS.Signals,
): void {
  const { child, start } = turn;
  if (start.shell === undefined || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    child.kill(signal);
  }
}

function detachable(start: TurnStart): boolean {
  return start.output !== "text";
}

function launchPath(
  start: TurnStart,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const service = start.runner?.kind === "container" ? process.env : {};
  return environment["PATH"] ?? service["PATH"];
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function commandFound(
  executable: string,
  place: { readonly directory: string; readonly path: string | undefined },
): boolean {
  if (executable === "") return false;
  if (executable.includes("/"))
    return executableFile(resolve(place.directory, executable));
  return (place.path ?? "")
    .split(delimiter)
    .filter((folder) => folder !== "")
    .some((folder) => executableFile(join(folder, executable)));
}

function launchedTurn(start: TurnStart): StartedTurn | undefined {
  const { parts: turnParts, standardInput } = turnCommand(start);
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  const environment = turnEnvironment(configuration, start);
  const parts = shellCommand(start, { configuration, parts: turnParts });
  try {
    const program = runnerProgram(start.runner, parts);
    const path = launchPath(start, environment);
    if (!commandFound(program, { ...start, path })) {
      rmSync(configuration, { recursive: true, force: true });
      return undefined;
    }
    const launch = runnerLaunch(start, {
      command: parts,
      environment,
      serviceEnvironment: process.env,
    });
    const [executable = "", ...rest] = launch.command;
    return detachedTurn({
      ...start,
      executable,
      arguments: rest,
      environment: launch.environment,
      standardInput,
      configuration,
      ...(launch.place === undefined ? {} : { runnerPlace: launch.place }),
    });
  } catch (error) {
    rmSync(configuration, { recursive: true, force: true });
    throw error;
  }
}

export function startTurn(start: TurnStart): StartedTurn {
  if (start.attach !== undefined) return attachedTurn(start, start.attach);
  recordPrompt(start);
  const launched = detachable(start) ? launchedTurn(start) : undefined;
  return launched ?? pipedTurn(start);
}

function pipedTurn(start: TurnStart): StartedTurn {
  const { child, configuration, standardInput, launch } = spawnTurn(start);
  const refused = launch.refusal(child.stderr);
  const output = turnOutput(start, child);
  child.stderr.pipe(createWriteStream(join(start.folder, "turn.stderr.log")));
  child.stdin.on("error", () => undefined);
  child.stdin.end(standardInput);
  const closed = new Promise<number | null>((settle) => {
    child.once("error", () => undefined);
    child.once("close", settle);
  });
  const exited = new Promise<TurnExit>((settle) => {
    child.once("exit", () => {
      settle("exited");
    });
    child.once("close", () => {
      settle("exited");
    });
  });
  const timers: NodeJS.Timeout[] = [];
  return {
    processId: child.pid ?? null,
    exited,
    ended: closed
      .then(async (exitCode) => {
        timers.forEach(clearTimeout);
        const reason = refused(exitCode);
        const produced = await output(exitCode, {
          refused: reason !== undefined,
        });
        return {
          exitCode,
          ...(reason === undefined ? {} : { reason }),
          result: reason === undefined ? produced : undefined,
        };
      })
      .finally(() => {
        rmSync(configuration, { recursive: true, force: true });
        return launch.release();
      }),
    stop: (graceMilliseconds) => {
      signalTurn({ child, start }, "SIGTERM");
      timers.push(
        setTimeout(() => {
          signalTurn({ child, start }, "SIGKILL");
        }, graceMilliseconds).unref(),
      );
    },
  };
}
