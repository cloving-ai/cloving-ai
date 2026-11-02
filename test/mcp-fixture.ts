import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Fields } from "../src/protocol.ts";
import { record } from "../src/protocol.ts";
import { stopChild } from "./stop-child.ts";
import { testMilliseconds } from "./test-timing.ts";
import type { CliResult } from "./service-fixture.ts";

export function request(input: {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}): Fields {
  return { jsonrpc: "2.0", ...input };
}

export function startMcp(
  options: {
    readonly runtime?: string;
    readonly directory?: string;
    readonly argumentsList?: readonly string[];
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const child = spawn(
    process.execPath,
    [resolve("src/cli.ts"), "mcp", ...(options.argumentsList ?? [])],
    {
      cwd: options.directory,
      env: {
        ...process.env,
        CLOVING_RUNTIME_DIR: options.runtime ?? "/unused",
        ...options.environment,
      },
      stdio: "pipe",
    },
  );
  const output = { stdout: "", stderr: "" };
  const messages: Fields[] = [];
  child.stdout.on("data", (data: Buffer) => {
    output.stdout += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output.stderr += data.toString();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    messages.push(record(JSON.parse(line)) ?? {});
  });
  const timer = setTimeout(() => {
    stopChild(child).catch(() => undefined);
  }, testMilliseconds(20_000));
  const completed = new Promise<CliResult>((settle, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      settle({ status: code ?? -1, ...output });
    });
  });
  return {
    child,
    messages,
    completed,
    line: (line: string) => {
      child.stdin.write(`${line}\n`);
    },
    send: (value: Fields) => {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    end: () => {
      child.stdin.end();
      return completed;
    },
  };
}

export async function mcpExchange(messages: readonly Fields[]) {
  const server = startMcp();
  for (const message of messages) server.send(message);
  return { ...(await server.end()), messages: server.messages };
}

export async function callTool(input: {
  readonly runtime: string;
  readonly name: string;
  readonly arguments?: Fields | undefined;
}): Promise<Fields> {
  const server = startMcp({ runtime: input.runtime });
  server.send(
    request({
      id: 1,
      method: "tools/call",
      params: {
        name: input.name,
        ...(input.arguments === undefined
          ? {}
          : { arguments: input.arguments }),
      },
    }),
  );
  const output = await server.end();
  if (output.status !== 0) throw new Error(output.stderr);
  return record(server.messages[0]?.["result"]) ?? {};
}
