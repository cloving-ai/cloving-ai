import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { record } from "../src/protocol.ts";
import { stopChild } from "./stop-child.ts";
import {
  digestOf,
  eventually,
  field,
  type Harness,
} from "./service-fixture.ts";

export const prompt = "Which parser is correct for the input format?";

interface Host {
  readonly process: ChildProcess;
  readonly lines: string[];
  readonly submit: (
    command: Readonly<Record<string, unknown>>,
    documents?: readonly string[],
  ) => Promise<unknown>;
}

export async function host(harness: Harness, mode: string): Promise<Host> {
  const child = spawn(
    process.execPath,
    [
      resolve("test/service-host.ts"),
      harness.stateDirectory,
      harness.runtimeDirectory,
      join(harness.stateDirectory, "deliveries.jsonl"),
      mode,
    ],
    {
      env:
        mode === "deliver"
          ? process.env
          : { ...process.env, NODE_V8_COVERAGE: undefined },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  harness.cleanup(() => stopChild(child));
  const lines: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) =>
    lines.push(line),
  );
  await eventually(() => (lines.includes("ready") ? true : undefined));
  return {
    process: child,
    lines,
    submit: async (command, documents = []) => {
      const before = lines.filter((line) => line.startsWith("result ")).length;
      child.stdin.write(`${JSON.stringify({ command, documents })}\n`);
      return eventually(() => {
        const results = lines.filter((line) => line.startsWith("result "));
        const [line] = results.slice(before);
        return line === undefined
          ? undefined
          : record(JSON.parse(line.slice("result ".length)));
      });
    },
  };
}

export async function continuations(
  harness: Harness,
): Promise<readonly unknown[]> {
  const lines = await readFile(
    join(harness.stateDirectory, "deliveries.jsonl"),
    "utf8",
  ).catch(() => "");
  return lines
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter((intent) => field(intent, "kind") === "continue-run");
}

export async function openedQuestion(
  first: Host,
  runId: string,
): Promise<void> {
  await first.submit({
    kind: "mark-started",
    runId,
    commandId: "w-started",
    expectedRevision: 1,
  });
  await first.submit(
    {
      kind: "open-gate",
      runId,
      commandId: "w-open",
      expectedRevision: 2,
      gateId: "design-1",
      gateKind: "question",
      subject: digestOf(prompt),
      prompt: digestOf(prompt),
    },
    [prompt],
  );
  await first.submit({
    kind: "register-wait",
    runId,
    commandId: "w-wait",
    gateId: "design-1",
  });
}
