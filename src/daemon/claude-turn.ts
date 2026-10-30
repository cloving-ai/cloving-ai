import { turnCommand } from "./turn-command.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codexStream } from "./codex-stream.ts";
import { cursorStream } from "./cursor-stream.ts";
import { opencodeStream } from "./opencode-stream.ts";
import { textOutput } from "./text-output.ts";
import { grokUsageWarnings } from "../grok-result.ts";
import { geminiStream } from "./gemini-stream.ts";
import {
  parsed,
  textOf,
  streamResult,
  type Worker,
  type StreamResult,
} from "./claude-stream.ts";
import { usageOf, type RetryKind } from "../worker-usage.ts";
export { streamResult, capacityRefusal, retryKind } from "./claude-stream.ts";
export type { Worker, StreamResult } from "./claude-stream.ts";
import { commandModel } from "../token-prices.ts";
import { shellTurnScript } from "../agent-harness-shell.ts";

export interface TurnEnd {
  readonly retryKind?: RetryKind | null;
  readonly resumedAfter?: "daemon-restart";
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
  readonly command: readonly string[];
  readonly directory: string;
  readonly folder: string;
  readonly activityFolder?: string;
  readonly prompt: string;
}

export interface TurnProgress {
  readonly sessionId: string | null;
  readonly result: StreamResult | undefined;
}

export interface RunningTurn {
  readonly processId: number | null;
  readonly ended: Promise<TurnEnd>;
  readonly stop: (graceMilliseconds: number) => void;
}

interface Stream {
  failure: { readonly error: unknown } | undefined;
  sessionId: string | null;
  saved: Promise<void>;
  errorType: string | null;
  model: string | null;
  pending: string;
  result: StreamResult | undefined;
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
  const excluded = new Set([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]);
  const supplied = Object.fromEntries(
    Object.entries(start.environment ?? {}).map(([name, value]) => [
      name,
      value.replaceAll("{turn}", start.turnId ?? ""),
    ]),
  );
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...supplied }).filter(
      ([name]) => !excluded.has(name),
    ),
  );
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
} {
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  const { parts, standardInput } = turnCommand(start);
  const command =
    start.shell === undefined
      ? parts
      : [
          start.shell,
          "-l",
          "-i",
          "-c",
          shellTurnScript,
          "cloving-harness",
          configuration,
          ...parts,
        ];
  const [executable = "", ...fixed] = command;
  try {
    const child = spawn(executable, fixed, {
      cwd: start.directory,
      env: turnEnvironment(configuration, start),
      stdio: ["pipe", "pipe", "pipe"],
      detached: start.shell !== undefined,
    });
    return { child, configuration, standardInput };
  } catch (error) {
    rmSync(configuration, { recursive: true, force: true });
    throw error;
  }
}

function streamMetadata(stream: Stream, event: unknown): boolean {
  const field = (name: string): unknown => Reflect.get(Object(event), name);
  const type = field("type");
  const sessionId = textOf(field("session_id"));
  const discovered = stream.sessionId === null && sessionId !== null;
  if (discovered) stream.sessionId = sessionId;
  if (type === "assistant" && field("parent_tool_use_id") == null)
    stream.errorType = textOf(field("error"));
  if (type === "system" || type === "result")
    stream.model = textOf(field("model")) ?? stream.model;
  return discovered;
}

function receivedLines(
  stream: Stream,
  input: {
    readonly lines: readonly string[];
    readonly worker?: Worker;
    readonly progress?: TurnStart["progress"];
    readonly failed: () => void;
  },
): void {
  const { lines, worker } = input;
  for (const line of lines) {
    const discovered = streamMetadata(stream, parsed(line));
    const result = streamResult(line, worker);
    if (result !== undefined) {
      const errorType = result.errorType ?? stream.errorType;
      stream.result = {
        ...result,
        sessionId: result.sessionId ?? stream.sessionId,
        ...(errorType === null ? {} : { errorType }),
      };
    }
    if (discovered || result !== undefined) {
      saveProgress(stream, input);
    }
  }
}

function saveProgress(
  stream: Stream,
  input: {
    readonly progress?: TurnStart["progress"];
    readonly failed: () => void;
  },
): void {
  const progress = { sessionId: stream.sessionId, result: stream.result };
  stream.saved = stream.saved
    .then(() => {
      if (stream.failure === undefined) return input.progress?.(progress);
      return undefined;
    })
    .catch((error: unknown) => {
      stream.failure = { error };
      input.failed();
    });
}

function activityOutput(start: TurnStart) {
  const output = createWriteStream(
    join(start.activityFolder ?? start.folder, "turn.jsonl"),
    { flags: start.activityFolder === undefined ? "w" : "a" },
  );
  if (start.activityFolder !== undefined) output.write("\n");
  return output;
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

function streamState(): Stream {
  return {
    failure: undefined,
    sessionId: null,
    saved: Promise.resolve(),
    pending: "",
    result: undefined,
    model: null,
    errorType: null,
  };
}

function turnOutput(
  start: TurnStart,
  child: ChildProcessWithoutNullStreams,
): (exitCode: number | null) => Promise<StreamResult | undefined> {
  const output = activityOutput(start);
  if (start.output === "text")
    return textOutput(child, { output, limit: start.resultBytes ?? 48_000 });
  const { stdout, stderr } = child;
  const adapter = streamAdapter(start.worker, stderr);
  const stream = streamState();
  const received = (lines: readonly string[]): void => {
    receivedLines(stream, {
      lines,
      progress: start.progress,
      failed: () => {
        signalTurn({ child, start }, "SIGKILL");
      },
      ...(start.worker === undefined ? {} : { worker: start.worker }),
    });
  };
  const written = (lines: readonly string[]): void => {
    for (const line of lines) output.write(`${line}\n`);
    received(lines);
  };
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    if (adapter === undefined) output.write(chunk);
    const lines = `${stream.pending}${chunk}`.split("\n");
    stream.pending = lines.pop() ?? "";
    if (adapter !== undefined) {
      written(lines.flatMap(adapter.line));
      return;
    }
    received(lines);
  });
  return async (exitCode) => {
    if (adapter !== undefined) {
      written(adapter.line(stream.pending));
      written([adapter.result(exitCode)]);
    }
    await ended(output);
    if (adapter === undefined) received([stream.pending]);
    await stream.saved;
    if (stream.failure !== undefined) throw stream.failure.error;
    const result = stream.result;
    return result === undefined
      ? undefined
      : {
          ...result,
          model: result.model ?? stream.model ?? commandModel(start.command),
        };
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

export function startTurn(start: TurnStart): RunningTurn {
  const { child, configuration, standardInput } = spawnTurn(start);
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
  const timers: NodeJS.Timeout[] = [];
  return {
    processId: child.pid ?? null,
    ended: closed
      .then(async (exitCode) => {
        timers.forEach(clearTimeout);
        const result = await output(exitCode);
        return {
          exitCode,
          result:
            result !== undefined && warnings.incomplete()
              ? { ...result, usage: usageOf(null), costUsd: null }
              : result,
        };
      })
      .finally(() => {
        rmSync(configuration, { recursive: true, force: true });
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
