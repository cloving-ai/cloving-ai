import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codexStream } from "./codex-stream.ts";
import { cursorStream } from "./cursor-stream.ts";
import { opencodeStream } from "./opencode-stream.ts";
import { textOutput } from "./text-output.ts";
import type { TicketStatus } from "../ticket-status.ts";
import { grokResultFields, grokUsageWarnings } from "../grok-result.ts";
import {
  priceOf,
  usageOf,
  type WorkerUsage,
  type WorkerAttemptUsage,
} from "../worker-usage.ts";
import { commandModel } from "../token-prices.ts";
import { shellTurnScript } from "../agent-harness-shell.ts";

export type Worker = string;

export interface StreamResult {
  readonly ticketStatusTooLarge?: true;
  readonly ticketStatus?: TicketStatus;
  readonly attempts?: readonly WorkerAttemptUsage[];
  readonly pricingModel?: string | null;
  readonly subtype?: string;
  readonly errorType?: string;
  readonly model: string | null;
  readonly text: string;
  readonly failed: boolean;
  readonly costUsd: number | null;
  readonly usage: WorkerUsage;
  readonly sessionId: string | null;
  readonly turns: number | null;
}

export interface TurnEnd {
  readonly stopped?: boolean;
  readonly exitCode: number | null;
  readonly result: StreamResult | undefined;
}

export interface TurnStart {
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

export interface RunningTurn {
  readonly processId: number | null;
  readonly ended: Promise<TurnEnd>;
  readonly stop: (graceMilliseconds: number) => void;
}

interface Stream {
  errorType: string | null;
  model: string | null;
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

export function capacityRefusal(result: StreamResult | undefined): boolean {
  return (
    result?.failed === true &&
    ["success", "error_during_execution"].includes(
      result.subtype ?? "error_during_execution",
    ) &&
    (result.text ===
      "Selected model is at capacity. Please try a different model." ||
      result.errorType === "overloaded")
  );
}

export function streamResult(
  line: string,
  worker?: Worker,
): StreamResult | undefined {
  if (!line.includes('"result"')) return undefined;
  const record: unknown = parsed(line);
  const field = (name: string): unknown => Reflect.get(Object(record), name);
  if (field("type") !== "result") return undefined;
  return {
    ...(typeof field("subtype") === "string"
      ? { subtype: String(field("subtype")) }
      : {}),
    ...(typeof field("error") === "string"
      ? { errorType: String(field("error")) }
      : {}),
    text: textOf(field("result")) ?? "",
    failed: field("is_error") === true,
    costUsd: priceOf(field("total_cost_usd")),
    usage: usageOf(field("usage")),
    model: textOf(field("model")),
    sessionId: textOf(field("session_id")),
    turns: numberOf(field("num_turns")),
    ...(worker === "grok" ? grokResultFields(record) : {}),
  };
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

function turnCommand(start: TurnStart): {
  readonly parts: readonly string[];
  readonly standardInput: string | undefined;
} {
  if (start.output === "text")
    return {
      parts: start.command.map((part) =>
        part === "{prompt}" ? start.prompt : part,
      ),
      standardInput: start.command.includes("{prompt}")
        ? undefined
        : start.prompt,
    };
  if (start.worker === "opencode")
    return {
      parts: [...start.command, start.prompt],
      standardInput: undefined,
    };
  if (
    start.worker === "cursor-agent" &&
    Buffer.byteLength(start.prompt, "utf8") < 64 * 1024
  )
    return {
      parts: [...start.command, start.prompt],
      standardInput: undefined,
    };
  if (start.worker !== "grok")
    return { parts: start.command, standardInput: start.prompt };
  const command = [...start.command];
  const index = command.findIndex(
    (argument, position) =>
      position > 0 && ["-p", "--single"].includes(argument),
  );
  command.splice(index < 0 ? command.length : index + 1, 0, start.prompt);
  return { parts: command, standardInput: undefined };
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
    return {
      child,
      configuration,
      standardInput,
    };
  } catch (error) {
    rmSync(configuration, { recursive: true, force: true });
    throw error;
  }
}

function receivedLines(
  stream: Stream,
  input: { readonly lines: readonly string[]; readonly worker?: Worker },
): void {
  const { lines, worker } = input;
  for (const line of lines) {
    const event = parsed(line);
    const field = (name: string): unknown => Reflect.get(Object(event), name);
    const type = field("type");
    if (type === "assistant" && field("parent_tool_use_id") == null)
      stream.errorType = textOf(field("error"));
    if (type === "system" || type === "result")
      stream.model = textOf(field("model")) ?? stream.model;
    const result = streamResult(line, worker);
    if (result !== undefined) {
      const errorType = result.errorType ?? stream.errorType;
      stream.result = {
        ...result,
        ...(errorType === null ? {} : { errorType }),
      };
    }
  }
}

function activityOutput(start: TurnStart) {
  const output = createWriteStream(
    join(start.activityFolder ?? start.folder, "turn.jsonl"),
    { flags: start.activityFolder === undefined ? "w" : "a" },
  );
  if (start.activityFolder !== undefined) output.write("\n");
  return output;
}

function streamAdapter(worker: Worker | undefined) {
  if (worker === "codex") return codexStream();
  if (worker === "cursor-agent") return cursorStream();
  return undefined;
}

function turnOutput(
  start: TurnStart,
  child: ChildProcessWithoutNullStreams,
): (exitCode: number | null) => Promise<StreamResult | undefined> {
  const output = activityOutput(start);
  if (start.output === "text")
    return textOutput(child, { output, limit: start.resultBytes ?? 48_000 });
  const translated = start.worker === "opencode" ? opencodeStream() : undefined;
  const adapter = translated ?? streamAdapter(start.worker);
  const { stdout, stderr } = child;
  if (translated !== undefined) {
    stderr.setEncoding("utf8");
    stderr.on("data", translated.stderr);
  }
  const stream: Stream = {
    pending: "",
    result: undefined,
    model: null,
    errorType: null,
  };
  const received = (lines: readonly string[]): void => {
    receivedLines(stream, {
      lines,
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
