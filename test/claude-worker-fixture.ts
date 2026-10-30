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
import { testMilliseconds } from "./test-timing.ts";

const fakeClaude = `
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const [mode = "complete", record = ""] = process.argv.slice(2);
if (mode === "ignore-term") process.on("SIGTERM", () => undefined);
if (mode === "resume-graceful") process.on("SIGTERM", () => process.exit(0));
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += String(chunk);
const turn = readFileSync(record, "utf8").split("\\n").length;
appendFileSync(record, JSON.stringify({ prompt, directory: process.cwd(), processId: process.pid, arguments: process.argv.slice(2), files: readdirSync("."), environment: Object.fromEntries(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "TMPDIR", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])) }) + "\\n");
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const session = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : "session-" + turn;
const result = (fields) => print({ type: "result", subtype: "success", is_error: false, result: "Done: " + prompt, total_cost_usd: 0.25, usage: { input_tokens: 1500, cache_read_input_tokens: 800, output_tokens: 150 }, session_id: session, num_turns: 3, ...fields });
const git = (...parts) => execFileSync("git", parts, { stdio: "ignore" });
const held = () => new Promise(() => { setInterval(() => undefined, 1000); });
print({ type: "system", subtype: "init", session_id: session });
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
  "hold-second": () => turn === 2 ? held() : modes["fixed-reply"](),
  "resume-once": () => { if (turn === 1) { result({ total_cost_usd: 1.2 }); return held(); } result({ total_cost_usd: 2, result: "Ticket status: complete" }); },
  "resume-graceful": () => modes["resume-once"](),
  "crash-once": () => turn === 1 ? held() : result({ result: "Ticket status: complete" }),
  "fallback-resume": () => {
    if (turn <= 2) return result({ is_error: true, result: "Selected model is at capacity. Please try a different model." });
    return turn === 3 ? held() : result({ result: "Ticket status: complete" });
  },
  "resume-cost": () => { if (turn === 1) { result({ total_cost_usd: 1.2 }); return held(); } if (turn === 2) { result({ total_cost_usd: 1.2, result: "" }); return result({ total_cost_usd: 2, is_error: true, result: "Selected model is at capacity. Please try a different model." }); } result({ total_cost_usd: 0.5 }); },
  "conflict-second": () => { const candidate = JSON.parse(readFileSync(record + ".reply", "utf8")); if (turn === 2) candidate.process.scope = "Conflicting scope."; result({ result: JSON.stringify(candidate) }); },
  "invalid-second": () => result({ result: turn === 2 ? "{}" : readFileSync(record + ".reply", "utf8") }),
  "planned-replies": () => { const replies = JSON.parse(readFileSync(record + ".reply", "utf8")); result({ result: JSON.stringify(replies[Math.min(turn - 1, replies.length - 1)]) }); },
  "fixed-reply": () => { process.stderr.write(prompt); result({ result: readFileSync(record + ".reply", "utf8") }); },
  committed: () => {
    writeFileSync("change-" + turn + ".txt", prompt);
    git("add", ".");
    git("commit", "-m", "Add the change " + turn);
    result({});
  },
  "echo-token": () => {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.stderr.write(token);
    print({ type: "assistant", text: token });
    result({ result: token, model: token, session_id: token });
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
function capacityTurn() {
  if (turn !== 1 && mode !== "capacity-always") return laterAttempt();
  writeFileSync("partial.txt", "retained partial work");
  if (mode === "overload-once") {
    print({ type: "assistant", error: "overloaded", parent_tool_use_id: null });
    return result({ subtype: "error_during_execution", is_error: true, result: "API failed" });
  }
  return result({ subtype: "error_during_execution", is_error: true, result: "Selected model is at capacity. Please try a different model.", ...(mode === "capacity-unknown-first" ? { total_cost_usd: null } : {}) });
}
function laterAttempt() {
  if (mode === "capacity-hold") return held();
  if (mode === "capacity-no-result") return modes["no-result"]();
  if (mode === "capacity-unknown") return result({ total_cost_usd: null, usage: { input_tokens: 2 }, num_turns: null });
  return existsSync(record + ".reply") ? modes["fixed-reply"]() : modes.complete();
}
const capacityModes = ["capacity-once", "capacity-always", "overload-once", "capacity-no-result", "capacity-unknown", "capacity-hold", "capacity-unknown-first"];
await (capacityModes.includes(mode) ? capacityTurn() : modes[mode]());
`;

export interface TurnRecord {
  readonly prompt: string;
  readonly directory: string;
  readonly processId: number;
  readonly arguments: readonly string[];
  readonly files: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
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
  const deadline = performance.now() + testMilliseconds(10_000);
  while (!(await reached()) && performance.now() < deadline) await delay(10);
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
      readFileSync(turnLog, "utf8").split("\n").filter(Boolean).map(turnRecord),
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

function turnRecord(line: string): TurnRecord {
  const parsed: unknown = JSON.parse(line);
  const texts = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : [];
  const environment: unknown = field(parsed, "environment");
  return {
    prompt: String(field(parsed, "prompt")),
    directory: String(field(parsed, "directory")),
    processId: Number(field(parsed, "processId")),
    arguments: texts(field(parsed, "arguments")),
    files: texts(field(parsed, "files")),
    environment: Object.fromEntries(
      Object.entries(environment ?? {}).map(([name, value]) => [
        name,
        String(value),
      ]),
    ),
  };
}
