import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelStream } from "./gemini-fixture.ts";
import { piEvents } from "./pi-fixture.ts";
import { opencodeEvents } from "./opencode-fixture.ts";
import {
  grokMessages,
  grokModelUsage,
  grokResult,
  grokUsage,
} from "./grok-worker-fixture.ts";
import {
  alive,
  journalKey,
  type Scene,
  type WorkerOverrides,
} from "./claude-worker-fixture.ts";

const gatedProgram = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [specification, gate, log] = process.argv.slice(2);
const { head, tail, stderr } = JSON.parse(readFileSync(specification, "utf8"));
const separator = process.argv.indexOf("--");
const prompt = separator < 0 ? null : process.argv[separator + 1];
appendFileSync(log, JSON.stringify({ processId: process.pid, parentId: process.ppid, prompt }) + "\\n");
const selected = process.argv.indexOf("--session");
const header = selected < 0 ? undefined : JSON.parse(readFileSync(process.argv[selected + 1], "utf8").split("\\n")[0]);
const output = (line) => header && line.startsWith('{"type":"session",') ? JSON.stringify(header) : line;
for (const line of head) process.stdout.write(output(line) + "\\n");
const timer = setInterval(() => {
  if (!existsSync(gate)) return;
  clearInterval(timer);
  for (const line of tail) process.stdout.write(output(line) + "\\n");
  process.stderr.write(stderr);
}, 20);
`;

export interface HarnessOutput {
  readonly head: readonly unknown[];
  readonly tail: readonly unknown[];
  readonly stderr?: string;
}

const codexOutput: HarnessOutput = {
  head: [
    { type: "thread.started", thread_id: "thread-9", model: "priced" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "Working." },
    },
  ],
  tail: [
    {
      type: "item.completed",
      item: { type: "agent_message", text: "Ticket status: complete" },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1_000_000,
        cached_input_tokens: 400_000,
        output_tokens: 100_000,
      },
    },
  ],
};

const cursorOutput: HarnessOutput = {
  head: [
    {
      type: "system",
      subtype: "init",
      session_id: "cursor-9",
      model: "priced",
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working." }] },
    },
  ],
  tail: [
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Ticket status: complete" }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      model: "priced",
      result: "Ticket status: complete",
      session_id: "cursor-9",
      usage: {
        inputTokens: 1_000_000,
        cacheReadTokens: 400_000,
        cacheWriteTokens: 0,
        outputTokens: 100_000,
      },
    },
  ],
};

export const harnessOutputs: Readonly<Record<string, HarnessOutput>> = {
  codex: codexOutput,
  pi: { head: piEvents().slice(0, 3), tail: piEvents().slice(3) },
  gemini: { head: modelStream.slice(0, 3), tail: modelStream.slice(3) },
  "cursor-agent": cursorOutput,
  opencode: {
    head: [
      { ...opencodeEvents[0], model: "priced" },
      ...opencodeEvents.slice(1, 3),
    ],
    tail: opencodeEvents.slice(3),
    stderr: "opencode closed\n",
  },
  grok: {
    head: grokMessages.slice(0, 2),
    tail: [
      ...grokMessages.slice(2),
      {
        ...grokResult,
        usage: grokUsage,
        modelUsage: { "grok-4.6": grokModelUsage },
      },
    ],
  },
};

export const harnessPrices = {
  "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
  priced: { input: 2, cachedInput: 0.5, output: 8 },
  "gemini-test-pro": { input: 2, cachedInput: 0.5, output: 8 },
  "gemini-test-flash": { input: 1, cachedInput: 0.25, output: 4 },
  "grok-4.6": { input: 3, cachedInput: 0.75, output: 15 },
};

export function gatedHarness(
  scene: Scene,
  harness: {
    readonly worker: string;
    readonly name: string;
    readonly output: HarnessOutput;
  },
): {
  readonly settings: WorkerOverrides;
  readonly gate: string;
  readonly log: string;
} {
  const base = join(scene.directory, harness.name);
  const program = `${base}.mjs`;
  const specification = `${base}.json`;
  const { head, tail, stderr = "" } = harness.output;
  writeFileSync(program, gatedProgram);
  writeFileSync(
    specification,
    JSON.stringify({
      head: head.map((line) => JSON.stringify(line)),
      tail: tail.map((line) => JSON.stringify(line)),
      stderr,
    }),
  );
  writeFileSync(`${base}.log`, "");
  return {
    settings: {
      worker: harness.worker,
      command: [
        "env",
        "-u",
        "NODE_V8_COVERAGE",
        process.execPath,
        program,
        specification,
        `${base}.gate`,
        `${base}.log`,
      ],
      tokenPrices: harnessPrices,
    },
    gate: `${base}.gate`,
    log: `${base}.log`,
  };
}

export function openGate(harness: { readonly gate: string }): void {
  writeFileSync(harness.gate, "");
}

export interface HarnessProcess {
  readonly processId: number;
  readonly parentId: number;
}

export function harnessProcesses(harness: {
  readonly log: string;
}): readonly HarnessProcess[] {
  return readFileSync(harness.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): HarnessProcess => {
      const parsed: unknown = JSON.parse(line);
      return {
        processId: Number(Reflect.get(Object(parsed), "processId")),
        parentId: Number(Reflect.get(Object(parsed), "parentId")),
      };
    });
}

export function processGroup(processId: number): number {
  return Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(processId)], {
      encoding: "utf8",
    }).trim(),
  );
}

export function operationFile(
  scene: Scene,
  place: { readonly operationId: string; readonly name: string },
): string {
  return join(scene.journal, journalKey(place.operationId), place.name);
}

export function transcriptLines(
  scene: Scene,
  operationId: string,
): readonly string[] {
  const path = operationFile(scene, { operationId, name: "turn.jsonl" });
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function stoppedProcess(processId: number): void {
  const own = processGroup(process.pid);
  const group = processGroup(processId);
  process.kill(group === own ? processId : -group, "SIGKILL");
}

export function stopHarnessGroups(harness: { readonly log: string }): void {
  for (const turn of harnessProcesses(harness)) {
    if (!alive(turn.processId)) continue;
    try {
      stoppedProcess(turn.processId);
    } catch {
      continue;
    }
  }
}
