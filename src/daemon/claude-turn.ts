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
import { codexStream } from "./codex-stream.ts";
import { cursorStream } from "./cursor-stream.ts";
import { opencodeStream } from "./opencode-stream.ts";
import { textOutput } from "./text-output.ts";
import {
  activityOutput,
  recordPrompt,
  type LaterAttempt,
} from "./turn-activity.ts";
import { grokUsageWarnings } from "../grok-result.ts";
import { geminiStream } from "./gemini-stream.ts";
import type { Worker, StreamResult } from "./claude-stream.ts";
import {
  receivedLines,
  receivedText,
  streamEnd,
  streamState,
  type TurnProgress,
} from "./turn-stream.ts";
import { usageOf, type ResumeReason, type RetryKind } from "../worker-usage.ts";
export { streamResult, capacityRefusal, retryKind } from "./claude-stream.ts";
export type { Worker, StreamResult } from "./claude-stream.ts";
export type { TurnProgress } from "./turn-stream.ts";
import { shellTurnCommand } from "../agent-harness-shell.ts";
import type { TurnRunner } from "../turn-runner.ts";
import { runnerLaunch, type RunnerLaunch } from "./turn-runner-spawn.ts";
import { attachedTurn, detachedTurn, type TurnExit } from "./detached-turn.ts";
import type { TurnLaunch } from "../turn-launch.ts";
import {
  commitSignatureSettings,
  githubTokens,
  passedVariables,
  withGitSettings,
  type CommitSignatures,
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
  readonly commitSignatures?: CommitSignatures;
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

function spawnTurn(start: TurnStart): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly configuration: string;
  readonly standardInput: string | undefined;
  readonly launch: RunnerLaunch;
} {
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  const { parts, standardInput } = turnCommand(start);
  const command =
    start.shell === undefined
      ? parts
      : shellTurnCommand(start.shell, { configuration, parts });
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

function streamAdapter(
  worker: Worker | undefined,
  stderr: ChildProcessWithoutNullStreams["stderr"],
) {
  if (worker === "opencode") {
    const translated = opencodeStream();
    stderr.setEncoding("utf8");
    stderr.on("data", translated.stderr);
    return translated;
  }
  if (worker === "codex") return codexStream();
  if (worker === "cursor-agent") return cursorStream();
  if (worker === "gemini") return geminiStream();
  return undefined;
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
  const { stdout, stderr } = child;
  const adapter = streamAdapter(start.worker, stderr);
  const stream = streamState();
  const input = {
    progress: start.progress,
    worker: start.worker,
    failed: () => {
      signalTurn({ child, start }, "SIGKILL");
    },
  };
  const written = (lines: readonly string[]): void => {
    for (const line of lines) output.write(`${line}\n`);
    receivedLines(stream, { ...input, lines });
  };
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    if (adapter === undefined) {
      output.write(chunk);
      receivedText(stream, { ...input, text: chunk });
      return;
    }
    const lines = `${stream.pending}${chunk}`.split("\n");
    stream.pending = lines.pop() ?? "";
    written(lines.flatMap(adapter.line));
  });
  return async (exitCode, close) => {
    if (adapter !== undefined) {
      written(adapter.line(stream.pending));
      written(close.refused ? [] : [adapter.result(exitCode)]);
    }
    await ended(output);
    if (adapter === undefined)
      receivedLines(stream, { ...input, lines: [stream.pending] });
    return streamEnd(stream, start.command);
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
  return (
    (start.worker ?? "claude") === "claude" &&
    start.output !== "text" &&
    start.shell === undefined &&
    (start.runner === undefined || start.runner.kind === "host")
  );
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
  const { parts, standardInput } = turnCommand(start);
  const [executable = "", ...rest] = parts;
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  const environment = withGitSettings(
    turnEnvironment(configuration, start),
    commitSignatureSettings(start.commitSignatures),
  );
  try {
    if (!commandFound(executable, { ...start, path: environment["PATH"] })) {
      rmSync(configuration, { recursive: true, force: true });
      return undefined;
    }
    return detachedTurn({
      ...start,
      executable,
      arguments: rest,
      environment,
      standardInput,
      configuration,
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
  const warnings = grokUsageWarnings();
  if (start.worker === "grok") {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", warnings.write);
  }
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
        const result = reason === undefined ? produced : undefined;
        return {
          exitCode,
          ...(reason === undefined ? {} : { reason }),
          result:
            result !== undefined && warnings.incomplete()
              ? { ...result, usage: usageOf(null), costUsd: null }
              : result,
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
