import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

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

export function startTurn(start: TurnStart): RunningTurn {
  const [executable = "", ...fixed] = start.command;
  const child = spawn(executable, fixed, {
    cwd: start.directory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = createWriteStream(join(start.folder, "turn.jsonl"));
  const errors = createWriteStream(join(start.folder, "turn.stderr.log"));
  const stream: Stream = { pending: "", result: undefined };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.write(chunk);
    const lines = `${stream.pending}${chunk}`.split("\n");
    stream.pending = lines.pop() ?? "";
    stream.result = lines.map(streamResult).findLast(Boolean) ?? stream.result;
  });
  child.stderr.pipe(errors);
  child.stdin.on("error", () => undefined);
  child.stdin.end(start.prompt);
  const closed = new Promise<number | null>((settle) => {
    child.once("error", () => {
      settle(null);
    });
    child.once("close", settle);
  });
  const timers: NodeJS.Timeout[] = [];
  return {
    processId: child.pid ?? null,
    ended: closed.then(async (exitCode) => {
      timers.forEach(clearTimeout);
      await ended(output);
      return {
        exitCode,
        result: streamResult(stream.pending) ?? stream.result,
      };
    }),
    stop: (graceMilliseconds) => {
      child.kill("SIGTERM");
      timers.push(
        setTimeout(() => child.kill("SIGKILL"), graceMilliseconds).unref(),
      );
    },
  };
}
