import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import {
  claudeWorker,
  type ClaudeWorker,
  type ClaudeWorkerSettings,
} from "../src/daemon/claude-worker.ts";
import type { WorkerReport } from "../src/daemon/operation-journal.ts";

const fakeClaude = `
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [mode = "complete", record = ""] = process.argv.slice(2);
if (mode === "ignore-term") process.on("SIGTERM", () => undefined);
let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);
const turn = readFileSync(record, "utf8").split("\\n").length;
appendFileSync(record, JSON.stringify({ prompt, directory: process.cwd(), processId: process.pid }) + "\\n");
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const result = (fields) => print({ type: "result", subtype: "success", is_error: false, result: "Done: " + prompt, total_cost_usd: 0.25, session_id: "session-1", num_turns: 3, ...fields });
const git = (...parts) => execFileSync("git", parts, { stdio: "ignore" });
const held = () => new Promise(() => { setInterval(() => undefined, 1000); });
print({ type: "system", subtype: "init", session_id: "session-1" });
print({ type: "assistant", text: "the word \\"result\\" is in this line" });
process.stdout.write("this line is no JSON text and has the word \\"result\\"\\n");
const modes = {
  complete: () => {
    writeFileSync("change-" + turn + ".txt", prompt);
    git("add", ".");
    git("commit", "-m", "Add the change " + turn);
    writeFileSync("loose.txt", "not committed");
    result({});
  },
  committed: () => {
    writeFileSync("change-" + turn + ".txt", prompt);
    git("add", ".");
    git("commit", "-m", "Add the change " + turn);
    result({});
  },
  "error-result": () => result({ subtype: "error_during_execution", is_error: true }),
  "exit-code": () => { result({}); process.exitCode = 3; },
  "no-result": () => undefined,
  bare: () => print({ type: "result", is_error: false }),
  long: () => result({ result: "x".repeat(40000) }),
  wide: () => result({ result: "\\u8a9e".repeat(40000) }),
  wreck: () => { rmSync(".git"); result({}); },
  unterminated: () => process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "no line end" })),
  hold: held,
  "ignore-term": held,
};
await modes[mode]();
`;

export interface TurnRecord {
  readonly prompt: string;
  readonly directory: string;
  readonly processId: number;
}

export interface Scene {
  readonly directory: string;
  readonly repository: string;
  readonly worktrees: string;
  readonly journal: string;
  readonly reports: WorkerReport[];
  readonly turns: () => readonly TurnRecord[];
  readonly worker: (
    mode: string,
    overrides?: Partial<ClaudeWorkerSettings>,
  ) => ClaudeWorker;
}

export function git(directory: string, parts: readonly string[]): string {
  return execFileSync("git", ["-C", directory, ...parts], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function journalKey(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex").slice(0, 32);
}

export function record(scene: Scene, name: string): unknown {
  const [operationId = "", file = ""] = name.split("/");
  const path = join(scene.journal, journalKey(operationId), file);
  const parsed: unknown = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : undefined;
  return parsed;
}

export function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

export function resultOf(text: unknown): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(String(text));
  return typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
}

export function alive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(
  reached: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let pass = 0; pass < 1_000 && !(await reached()); pass += 1)
    await delay(10);
  if (!(await reached())) throw new Error("The scene did not reach its state.");
}

export function intent(
  overrides: Partial<DeliveryIntent> = {},
): DeliveryIntent {
  return {
    kind: "protected-effect",
    runId: "run-1",
    operationId: "operation-1",
    workflow: "sha256:pin",
    inputDigest: `sha256:${"a".repeat(64)}`,
    purpose: "dispatch",
    leaseGeneration: 1,
    capability: "claude",
    method: "run-turn",
    target: "ticket/one",
    payload: "sha256:prompt",
    ...overrides,
  };
}

function repository(directory: string): string {
  const path = join(directory, "repository");
  mkdirSync(path);
  git(path, ["init", "--quiet", "--initial-branch", "main"]);
  git(path, ["config", "user.name", "Cloving Test"]);
  git(path, ["config", "user.email", "test@cloving.invalid"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(path, "README.md"), "The fixture project.\n");
  git(path, ["add", "."]);
  git(path, ["commit", "--quiet", "-m", "Start the project"]);
  return path;
}

export async function withScene<Result>(
  use: (scene: Scene) => Promise<Result>,
): Promise<Result> {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "cloving-claude-")),
  );
  const script = join(directory, "fake-claude.mjs");
  const turnLog = join(directory, "turns.log");
  writeFileSync(script, fakeClaude);
  writeFileSync(turnLog, "");
  const workers: ClaudeWorker[] = [];
  const reports: WorkerReport[] = [];
  const scene: Scene = {
    directory,
    repository: repository(directory),
    worktrees: join(directory, "worktrees"),
    journal: join(directory, "journal"),
    reports,
    turns: () =>
      readFileSync(turnLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line): TurnRecord => {
          const parsed: unknown = JSON.parse(line);
          return {
            prompt: String(field(parsed, "prompt")),
            directory: String(field(parsed, "directory")),
            processId: Number(field(parsed, "processId")),
          };
        }),
    worker: (mode, overrides = {}) => {
      const made = claudeWorker({
        repository: scene.repository,
        worktrees: scene.worktrees,
        journal: scene.journal,
        command: [process.execPath, script, mode, turnLog],
        document: (digest) => Promise.resolve(`prompt of ${digest}`),
        report: (report) => {
          reports.push(report);
          return Promise.resolve();
        },
        stopMilliseconds: 100,
        ...overrides,
      });
      workers.push(made);
      return made;
    },
  };
  try {
    return await use(scene);
  } finally {
    for (const made of workers) await made.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
