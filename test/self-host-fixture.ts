import { stopChildGroup } from "./stop-child.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";

const entry = join(import.meta.dirname, "../src/cli.ts");

export const fakeClaude = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const work = prompt.includes("with this feedback:") ? "feedback" : "ticket";
writeFileSync(work + "-work.txt", prompt.split("\\n").at(-1) + "\\n");
execFileSync("git", ["add", work + "-work.txt"]);
execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "commit", "-q", "-m", "Add the " + work + " work"]);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
line({ type: "assistant", message: { content: [{ type: "text", text: "I add the file." }, { type: "tool_use", name: "Bash", input: { command: "git commit" } }] } });
line({ type: "result", subtype: "success", is_error: false, result: "I added the file ticket-work.txt.", total_cost_usd: 0.01, session_id: "session-1", num_turns: 1 });
`;

const fakeBoard = `
const ticket = process.argv.at(-1);
if (ticket !== "CLV-900") { process.stderr.write("no task has the key " + ticket + "\\n"); process.exit(3); }
process.stdout.write("# CLV-900: Add the ticket work\\n\\nGitHub issue: acme/demo#900 (open)\\n\\nthe last line of CLV-900\\n");
`;

export function git(
  directory: string,
  argumentsList: readonly string[],
): string {
  return execFileSync("git", ["-C", directory, ...argumentsList], {
    encoding: "utf8",
  });
}

export interface Scene {
  readonly root: string;
  readonly directory: string;
  readonly repository: string;
  readonly origin: string;
  readonly runtimeDirectory: string;
  readonly start: (
    environment?: Readonly<NodeJS.ProcessEnv>,
    argumentsList?: readonly string[],
  ) => Promise<ChildProcess>;
  readonly refused: (
    bound?: string,
    environment?: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<string>;
}

const children: ChildProcess[] = [];

function withOrigin(root: string, repository: string): string {
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", repository, origin]);
  git(repository, ["remote", "add", "origin", origin]);
  git(repository, ["fetch", "-q", "origin"]);
  git(repository, ["remote", "set-head", "origin", "main"]);
  return origin;
}

export async function scene(script = fakeClaude): Promise<Scene> {
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
  const origin = withOrigin(root, repository);
  await writeFile(join(root, "fake-claude.mjs"), script);
  await writeFile(join(root, "fake-board.mjs"), fakeBoard);
  const settings = {
    directory,
    repository,
    command: [process.execPath, join(root, "fake-claude.mjs")],
    board: [process.execPath, join(root, "fake-board.mjs")],
  };
  return {
    root,
    directory,
    repository,
    origin,
    runtimeDirectory: join(directory, "run"),
    start: async (environment = {}, argumentsList = []) =>
      (
        await launched(
          { ...settings, environment, argumentsList },
          "Cloving runs",
        )
      ).child,
    refused: (bound = "8", environment = {}) =>
      refused({ ...settings, bound, environment }),
  };
}

interface Launch {
  readonly child: ChildProcess;
  readonly output: { text: string };
}

async function refused(
  settings: Parameters<typeof launched>[0],
): Promise<string> {
  const { child, output } = await launched(
    settings,
    "The daemon did not start",
  );
  if (child.exitCode === null && child.signalCode === null)
    await new Promise<undefined>((settle) =>
      child.once("close", () => {
        settle(undefined);
      }),
    );
  return output.text;
}

async function launched(
  settings: {
    readonly directory: string;
    readonly repository: string;
    readonly command: readonly string[];
    readonly board: readonly string[];
    readonly bound?: string;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly argumentsList?: readonly string[];
  },
  expected: string,
): Promise<Launch> {
  const child = spawn(
    process.execPath,
    [entry, "start", ...(settings.argumentsList ?? [])],
    {
      cwd: settings.repository,
      env: {
        ...process.env,
        CLOVING_RUNTIME_DIR: join(settings.directory, "run"),
        CLOVING_WORKER: undefined,
        CLOVING_CODEX_COMMAND: undefined,
        CLOVING_CLAUDE_COMMAND: JSON.stringify(settings.command),
        CLOVING_TICKET_COMMAND: JSON.stringify(settings.board),
        CLOVING_OWNERSHIP_LEASE_SECONDS: "2",
        CLOVING_HOST_BOUND: settings.bound ?? "8",
        CLOVING_WATCH_PORT: "off",
        XDG_CONFIG_HOME: join(settings.directory, "configuration"),
        ...settings.environment,
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
  for (let waited = 0; waited < testMilliseconds(30_000) / 20; waited += 1) {
    if (output.text.includes(expected)) return { child, output };
    await delay(20);
  }
  throw new Error(`The daemon did not print "${expected}": ${output.text}`);
}

export function ended(child: ChildProcess): Promise<number | null> {
  return new Promise((settle) => {
    child.once("close", settle);
    child.kill("SIGTERM");
  });
}

export async function reached<Value>(
  read: () => Promise<Value | undefined>,
): Promise<Value> {
  for (let waited = 0; waited < 1_500; waited += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("The scene did not reach its state.");
}

export function field(value: unknown, name: string | number): unknown {
  return Reflect.get(Object(value), name);
}

export type Asked = (
  operation: string,
  parameters: Readonly<Record<string, unknown>>,
) => Promise<Readonly<Record<string, unknown>>>;

export function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

export function withoutChildren(scene: () => Promise<void>): Promise<void> {
  return scene().finally(async () => {
    for (const child of children) await stopChildGroup(child);
  });
}
