import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { call } from "./service-fixture.ts";

const tool = join(import.meta.dirname, "../tools/self-host.ts");

const fakeClaude = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync("ticket-work.txt", prompt.split("\\n").at(-1) + "\\n");
execFileSync("git", ["add", "ticket-work.txt"]);
execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "commit", "-q", "-m", "Add the ticket work"]);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
line({ type: "result", subtype: "success", is_error: false, result: "I added the file ticket-work.txt.", total_cost_usd: 0.01, session_id: "session-1", num_turns: 1 });
`;

const slowClaude = `
import { setTimeout as delay } from "node:timers/promises";
for await (const chunk of process.stdin) chunk.toString();
await delay(60000);
`;

function git(directory: string, argumentsList: readonly string[]): string {
  return execFileSync("git", ["-C", directory, ...argumentsList], {
    encoding: "utf8",
  });
}

interface Scene {
  readonly directory: string;
  readonly repository: string;
  readonly runtimeDirectory: string;
  readonly start: () => Promise<ChildProcess>;
  readonly refused: (bound?: string) => Promise<string>;
}

const children: ChildProcess[] = [];

async function scene(script = fakeClaude): Promise<Scene> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloving-self-")));
  process.on("exit", () => {
    rmSync(root, { recursive: true, force: true });
  });
  const repository = join(root, "repository");
  const directory = join(root, "host");
  execFileSync("git", ["init", "-q", "-b", "main", repository]);
  await writeFile(join(repository, "README.md"), "A project.\n");
  git(repository, ["add", "README.md"]);
  git(repository, [
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@example.invalid",
    "commit",
    "-q",
    "-m",
    "Start the project",
  ]);
  await writeFile(join(root, "fake-claude.mjs"), script);
  const settings = {
    directory,
    repository,
    command: [process.execPath, join(root, "fake-claude.mjs")],
  };
  return {
    directory,
    repository,
    runtimeDirectory: join(directory, "runtime"),
    start: async () => (await launched(settings, "Cloving runs")).child,
    refused: async (bound = "8") =>
      (await launched({ ...settings, bound }, "The daemon did not start"))
        .output.text,
  };
}

interface Launch {
  readonly child: ChildProcess;
  readonly output: { text: string };
}

async function launched(
  settings: {
    readonly directory: string;
    readonly repository: string;
    readonly command: readonly string[];
    readonly bound?: string;
  },
  expected: string,
): Promise<Launch> {
  const child = spawn(
    process.execPath,
    [tool, settings.directory, settings.repository],
    {
      env: {
        ...process.env,
        CLOVING_CLAUDE_COMMAND: JSON.stringify(settings.command),
        CLOVING_OWNERSHIP_LEASE_SECONDS: "2",
        CLOVING_HOST_BOUND: settings.bound ?? "8",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  children.push(child);
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      output.text += chunk.toString();
    });
  for (let waited = 0; waited < 1_500; waited += 1) {
    if (output.text.includes(expected)) return { child, output };
    await delay(20);
  }
  throw new Error(`The daemon did not print "${expected}": ${output.text}`);
}

function ended(child: ChildProcess): Promise<number | null> {
  return new Promise((settle) => {
    child.once("close", settle);
    child.kill("SIGTERM");
  });
}

async function reached<Value>(
  read: () => Promise<Value | undefined>,
): Promise<Value> {
  for (let waited = 0; waited < 1_500; waited += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("The scene did not reach its state.");
}

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

type Asked = (
  operation: string,
  parameters: Readonly<Record<string, unknown>>,
) => Promise<Readonly<Record<string, unknown>>>;

function ticket(prompt: string, commandId: string): Record<string, unknown> {
  return {
    workflowId: "develop-ticket",
    source: "prompt",
    submission: { prompt },
    commandId,
  };
}

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

async function reviewed(
  asked: Asked,
  work: { readonly runId: string; readonly repository: string },
): Promise<unknown> {
  const { runId, repository } = work;
  const decision = await reached(
    async () => items((await asked("questions", { runId }))["decisions"])[0],
  );
  const prompt = String(field(decision, "prompt"));
  const [branch = ""] = /cloving\/ticket-[A-Za-z0-9-]+/.exec(prompt) ?? [];
  assert.equal(field(decision, "type"), "approval");
  assert.match(prompt, /I added the file ticket-work\.txt\./);
  assert.match(prompt, /ticket-work\.txt \| 1 \+/);
  assert.match(
    git(repository, ["log", "--oneline", branch]),
    /Add the ticket work/,
  );
  assert.equal(
    git(repository, ["show", `${branch}:ticket-work.txt`]),
    "the last line\n",
  );
  await reached(async () => {
    const listed = await asked("events", { after: 0, limit: 100, runId });
    return JSON.stringify(listed["events"]).includes("gate.wait-registered")
      ? listed
      : undefined;
  });
  return decision;
}

async function approved(
  asked: Asked,
  work: { readonly runId: string; readonly decision: unknown },
): Promise<unknown> {
  const { runId, decision } = work;
  const recorded = await asked("decision", {
    command: "approve",
    reference: field(decision, "decisionId"),
    expectedRevision: field(decision, "revision"),
    generation: field(decision, "generation"),
    subjectDigest: field(decision, "subjectDigest"),
    commandId: "c-approve",
  });
  assert.notEqual(recorded["kind"], "error", JSON.stringify(recorded));
  return await reached(async () => {
    const run = field(await asked("status", { runId }), "run");
    return field(run, "state") === "completed" ? run : undefined;
  });
}

async function ticketRun(): Promise<void> {
  const { directory, repository, runtimeDirectory, start, refused } =
    await scene();
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  assert.match(
    await refused("65"),
    /The daemon did not start: host-unavailable: invalid-host-bound: 65/,
  );
  const first = await start();
  const empty = await asked("run", ticket(" ", "c-0"));
  assert.deepEqual(
    [empty["kind"], empty["code"]],
    ["error", "invalid-submission"],
  );
  assert.match(await refused(), /The daemon did not start: [a-z-]+: /);
  const admitted = await asked(
    "run",
    ticket("Add the file ticket-work.txt.\nthe last line", "c-1"),
  );
  const runId = String(admitted["runId"]);
  const decision = await reviewed(asked, { runId, repository });
  assert.equal(await ended(first), 0);
  assert.equal(existsSync(join(directory, "worktrees")), true);
  const second = await start();
  const state = await approved(asked, { runId, decision });
  assert.equal(field(field(state, "budget"), "spent"), 1);
  assert.equal(await ended(second), 0);
}

async function stoppedTurn(): Promise<void> {
  const { runtimeDirectory, start } = await scene(slowClaude);
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  const effects = async (runId: string): Promise<readonly unknown[]> => {
    const run = field(await asked("status", { runId }), "run");
    return [
      field(run, "state"),
      ...items(field(run, "effects")).map((effect) => field(effect, "state")),
    ];
  };
  const first = await start();
  const admitted = await asked("run", ticket("A long ticket.", "c-1"));
  const runId = String(admitted["runId"]);
  await reached(async () =>
    (await effects(runId)).includes("running") ? runId : undefined,
  );
  await delay(300);
  assert.equal(await ended(first), 0);
  const second = await start();
  const shown = await reached(async () => {
    const [state, effect] = await effects(runId);
    return state === "completed" ? [state, effect] : undefined;
  });
  assert.deepEqual(shown, ["completed", "stopped"]);
  assert.equal(await ended(second), 0);
}

function withoutChildren(scene: () => Promise<void>): Promise<void> {
  return scene().finally(() => {
    for (const child of children)
      if (child.exitCode === null) process.kill(-Number(child.pid), "SIGKILL");
  });
}

await test("CLV-010 a stop of the daemon stops a Claude turn in work and reports it, and after the next start the run has an end with the stopped effect", () =>
  withoutChildren(stoppedTurn));

await test("CLV-010 the start command starts a daemon that refuses a host bound that is too large, a second daemon and an empty ticket, runs one ticket with the Claude worker in a work tree, waits for the approval of the operator across a restart, and completes the run after the approval", () =>
  withoutChildren(ticketRun));
