import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codexStream } from "./codex-stream.ts";

export type Worker = "claude" | "codex";

export interface StreamResult {
  readonly text: string;
  readonly failed: boolean;
  readonly costUsd: number | null;
  readonly sessionId: string | null;
  readonly turns: number | null;
}

export interface TurnEnd {
  readonly exitCode: number | null;
  readonly result: StreamResult | undefined;
}

export interface TurnStart {
  readonly worker?: Worker;
  readonly command: readonly string[];
  readonly directory: string;
  readonly folder: string;
  readonly prompt: string;
}

export interface RunningTurn {
  readonly processId: number | null;
  readonly ended: Promise<TurnEnd>;
  readonly stop: (graceMilliseconds: number) => void;
}

interface Stream {
  pending: string;
  result: StreamResult | undefined;
}

function parsed(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    return undefined;
  }
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function streamResult(line: string): StreamResult | undefined {
  if (!line.includes('"result"')) return undefined;
  const record: unknown = parsed(line);
  const field = (name: string): unknown => Reflect.get(Object(record), name);
  if (field("type") !== "result") return undefined;
  return {
    text: textOf(field("result")) ?? "",
    failed: field("is_error") === true,
    costUsd: numberOf(field("total_cost_usd")),
    sessionId: textOf(field("session_id")),
    turns: numberOf(field("num_turns")),
  };
}

function ended(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((settle) => {
    stream.end(settle);
  });
}

function turnEnvironment(configuration: string): NodeJS.ProcessEnv {
  const excluded = new Set([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !excluded.has(name)),
  );
  environment["GH_CONFIG_DIR"] = configuration;
  return environment;
}

function spawnTurn(start: TurnStart): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly configuration: string;
} {
  const configuration = mkdtempSync(join(start.folder, "gh-config-"));
  const [executable = "", ...fixed] = start.command;
  try {
    const child = spawn(executable, fixed, {
      cwd: start.directory,
      env: turnEnvironment(configuration),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { child, configuration };
  } catch (error) {
    rmSync(configuration, { recursive: true, force: true });
    throw error;
  }
}

function turnOutput(
  start: TurnStart,
  stdout: ChildProcessWithoutNullStreams["stdout"],
): (exitCode: number | null) => Promise<StreamResult | undefined> {
  const output = createWriteStream(join(start.folder, "turn.jsonl"));
  const codex = start.worker === "codex" ? codexStream() : undefined;
  const stream: Stream = { pending: "", result: undefined };
  const written = (lines: readonly string[]): void => {
    for (const line of lines) output.write(`${line}\n`);
    stream.result = lines.map(streamResult).findLast(Boolean) ?? stream.result;
  };
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    if (codex === undefined) output.write(chunk);
    const lines = `${stream.pending}${chunk}`.split("\n");
    stream.pending = lines.pop() ?? "";
    if (codex !== undefined) {
      written(lines.flatMap(codex.line));
      return;
    }
    stream.result = lines.map(streamResult).findLast(Boolean) ?? stream.result;
  });
  return async (exitCode) => {
    if (codex !== undefined) {
      written(codex.line(stream.pending));
      written([codex.result(exitCode)]);
    }
    await ended(output);
    return codex === undefined
      ? (streamResult(stream.pending) ?? stream.result)
      : stream.result;
  };
}

export function startTurn(start: TurnStart): RunningTurn {
  const { child, configuration } = spawnTurn(start);
  const output = turnOutput(start, child.stdout);
  const errors = createWriteStream(join(start.folder, "turn.stderr.log"));
  child.stderr.pipe(errors);
  child.stdin.on("error", () => undefined);
  child.stdin.end(start.prompt);
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
        return {
          exitCode,
          result: await output(exitCode),
        };
      })
      .finally(() => {
        rmSync(configuration, { recursive: true, force: true });
      }),
    stop: (graceMilliseconds) => {
      child.kill("SIGTERM");
      timers.push(
        setTimeout(() => child.kill("SIGKILL"), graceMilliseconds).unref(),
      );
    },
  };
}
