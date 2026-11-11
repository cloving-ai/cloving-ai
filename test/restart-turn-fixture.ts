import { execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, cpSync, symlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { transcriptKinds } from "../src/cli/watch-api-document.ts";
import { record } from "../src/protocol.ts";
import { recordedLaunch, type TurnLaunch } from "../src/turn-launch.ts";
import type { TranscriptEntry } from "../src/turn-transcript.ts";
import { rememberedBuild } from "../tools/restart-build.ts";
import {
  field,
  items,
  scene,
  withoutChildren,
  type Scene,
} from "./self-host-fixture.ts";
import { call, runCli } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const worktree = join(import.meta.dirname, "..");

function noReply(): Readonly<Record<string, unknown>> {
  return {};
}

function failedCall(error: unknown): Readonly<Record<string, unknown>> {
  return { kind: "error", detail: String(error) };
}

export const lineTurn = `
import { writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(new URL("./turn.pid", import.meta.url), String(process.pid));
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
for (let index = 1; index <= 60; index += 1) {
  line({ type: "assistant", message: { content: [{ type: "text", text: "line " + index + " from " + process.pid }] } });
  await new Promise((done) => setTimeout(done, 1000));
}
line({ type: "result", subtype: "success", is_error: false, result: "I wrote 60 lines.", total_cost_usd: 0.25, session_id: "session-1", num_turns: 1 });
`;

const workflowSource = `import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function longTurn(input: { readonly input: { readonly name: string } }) {
  "use workflow";
  const effect = await protectedEffect({
    scope: { phase: "work", operation: "turn", round: 1 },
    capability: "claude", method: "run-turn", target: "shared", payload: "Turn " + input.input.name, units: 1,
  });
  return { kind: effect.kind === "completed" ? "handoff_requested" : "blocked", reason: effect.kind };
}
`;

const declaration = {
  workflow: {
    workflowId: "long-turn",
    effectLimit: 2,
    capabilities: ["claude"],
    input: { maximumBytes: 1024, fields: { name: { type: "string" } } },
  },
  methods: { claude: ["run-turn"] },
};

export type ProductGit = (argumentsList: readonly string[]) => string;

export function productGit(product: string): ProductGit {
  return (argumentsList) =>
    execFileSync("git", ["-C", product, ...argumentsList], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

async function productCopy(root: string): Promise<string> {
  const product = join(root, "product");
  await mkdir(product);
  for (const name of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ])
    copyFileSync(join(worktree, name), join(product, name));
  for (const name of ["src", "tools", "templates", "dist"])
    cpSync(join(worktree, name), join(product, name), { recursive: true });
  symlinkSync(join(worktree, "node_modules"), join(product, "node_modules"));
  const git = productGit(product);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Owner"]);
  git(["config", "user.email", "owner@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(product, ".git/info/exclude"), "dist\nnode_modules\n");
  git(["add", "."]);
  git(["commit", "-qm", "Copy the product"]);
  return product;
}

export interface TurnHost {
  readonly fixture: Scene;
  readonly product: string;
  readonly host: ChildProcess;
  readonly output: () => string;
  readonly ending: AbortSignal;
}

function captured(child: ChildProcess): () => string {
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk: Buffer) => {
      output.text += chunk.toString();
    });
  return () => output.text;
}

async function stopTurns(root: string): Promise<void> {
  const names = (await readdir(root)).filter((name) => name.endsWith(".pid"));
  for (const name of names) {
    const processId = Number(await readFile(join(root, name), "utf8"));
    try {
      process.kill(processId, "SIGKILL");
    } catch {
      continue;
    }
  }
}

export async function withTurnHost(
  options: {
    readonly script: string;
    readonly prepare?: (product: string) => Promise<void>;
  },
  body: (scene: TurnHost) => Promise<void>,
): Promise<void> {
  const productRoot = await mkdtemp(join(tmpdir(), "cloving-turn-product-"));
  try {
    const product = await productCopy(productRoot);
    await options.prepare?.(product);
    await rememberedBuild(product);
    await withoutChildren(async () => {
      const fixture = await scene(options.script, join(product, "src/cli.ts"));
      const workflows = join(fixture.repository, ".cloving/workflows");
      await mkdir(workflows, { recursive: true });
      await writeFile(join(workflows, "long-turn.ts"), workflowSource);
      await writeFile(
        join(workflows, "long-turn.declaration.json"),
        JSON.stringify(declaration),
      );
      const ending = new AbortController();
      try {
        const host = await fixture.start({
          CLOVING_PHONE_RELAY: "off",
          NODE_V8_COVERAGE: undefined,
        });
        const output = captured(host);
        await body({ fixture, product, host, output, ending: ending.signal });
      } finally {
        ending.abort();
        await stopTurns(fixture.root);
      }
    });
  } finally {
    await rm(productRoot, { recursive: true, force: true });
  }
}

export async function admittedTurn(
  fixture: Scene,
  name: string,
): Promise<string> {
  const admitted = await call(fixture, {
    operation: "run",
    parameters: {
      workflowId: "long-turn",
      source: "declared",
      commandId: `turn-${name}`,
      submission: { name },
    },
  });
  if (admitted["kind"] !== "run-admitted")
    throw new Error(JSON.stringify(admitted));
  return String(admitted["runId"]);
}

export interface StartedTurn {
  readonly operationId: string;
  readonly folder: string;
  readonly launch: TurnLaunch;
}

export async function startedTurn(
  fixture: Scene,
  runId: string,
): Promise<StartedTurn> {
  const journal = join(fixture.directory, "journal");
  return await until(async () => {
    for (const name of await readdir(journal).catch(() => [])) {
      const folder = join(journal, name);
      const started: unknown = JSON.parse(
        await readFile(join(folder, "started.json"), "utf8").catch(() => "{}"),
      );
      const launch = recordedLaunch(field(started, "launch"));
      const operationId = String(field(started, "operationId"));
      if (operationId.includes(JSON.stringify(runId)) && launch !== undefined)
        return { operationId, folder, launch };
    }
    return undefined;
  });
}

export async function runStatus(
  fixture: Scene,
  runId: string,
): Promise<unknown> {
  const status = await call(fixture, {
    operation: "status",
    parameters: { runId },
  }).catch(noReply);
  return status["run"];
}

export async function until<Value>(
  read: () => Promise<Value | undefined>,
  milliseconds = testMilliseconds(100_000),
): Promise<Value> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error("The turn scene did not reach its state.");
}

export async function finishedRun(
  fixture: Scene,
  runId: string,
): Promise<unknown> {
  return await until(async () => {
    const run = await runStatus(fixture, runId);
    return ["completed", "blocked", "failed", "cancelled"].includes(
      String(field(run, "state")),
    )
      ? run
      : undefined;
  });
}

export interface TranscriptWatch {
  readonly entries: () => readonly TranscriptEntry[];
  readonly closed: Promise<readonly TranscriptEntry[]>;
}

function nullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  const entry = record(value) ?? {};
  return (
    [entry["position"], entry["attempt"], entry["omittedBytes"]].every(
      (count) => Number.isSafeInteger(count),
    ) &&
    transcriptKinds.some((kind) => kind === entry["kind"]) &&
    [entry["text"], entry["summary"]].every(
      (text) => typeof text === "string",
    ) &&
    [entry["tool"], entry["callId"]].every(nullableText) &&
    typeof entry["error"] === "boolean"
  );
}

function pageEntries(
  page: Readonly<Record<string, unknown>>,
): readonly TranscriptEntry[] {
  const shown = items(page["entries"]);
  const entries = shown.filter(isTranscriptEntry);
  if (entries.length !== shown.length)
    throw new Error(
      `The transcript reply has an unknown entry: ${JSON.stringify(page)}`,
    );
  return entries;
}

export function watchedTranscript(
  scene: Pick<TurnHost, "fixture" | "ending">,
  turn: { readonly runId: string; readonly operationId: string },
): TranscriptWatch {
  const entries: TranscriptEntry[] = [];
  const read = { after: 0, last: "no reply" };
  const closed = until(async () => {
    if (scene.ending.aborted) return entries;
    const page = await call(scene.fixture, {
      operation: "transcript",
      parameters: { ...turn, after: read.after },
    }).catch(failedCall);
    read.last = JSON.stringify(page);
    const shown = pageEntries(page);
    entries.push(...shown);
    if (typeof page["nextAfter"] === "number") read.after = page["nextAfter"];
    return page["open"] === false && shown.length === 0 ? entries : undefined;
  }).catch((error: unknown) => {
    throw new Error(`The transcript did not close. Last reply: ${read.last}`, {
      cause: error,
    });
  });
  closed.catch(() => undefined);
  return { entries: () => entries, closed };
}

export async function workflowBundles(
  directory: string,
): Promise<readonly string[]> {
  const names = await readdir(join(directory, "workflow-bundles"));
  return names.filter((name) => /^[0-9a-f]{64}$/.test(name)).sort();
}

export function assistantTexts(
  entries: readonly TranscriptEntry[],
): readonly string[] {
  return entries
    .filter((entry) => entry.kind === "assistant")
    .map((entry) => entry.text);
}

export function writtenLines(processId: number): readonly string[] {
  return Array.from(
    { length: 60 },
    (_, index) => `line ${String(index + 1)} from ${String(processId)}`,
  );
}

export interface WritingTurn {
  readonly turn: StartedTurn;
  readonly watch: TranscriptWatch;
  readonly processId: number;
}

export async function writingTurn(
  scene: Pick<TurnHost, "fixture" | "ending">,
  runId: string,
): Promise<WritingTurn> {
  const turn = await startedTurn(scene.fixture, runId);
  const watch = watchedTranscript(scene, {
    runId,
    operationId: turn.operationId,
  });
  await until(() =>
    Promise.resolve(
      assistantTexts(watch.entries()).length >= 5 ? true : undefined,
    ),
  );
  const processId = Number(
    await readFile(join(scene.fixture.root, "turn.pid"), "utf8"),
  );
  return { turn, watch, processId };
}

export async function restartedTurns(
  fixture: Scene,
  options: readonly string[],
): Promise<unknown> {
  const restart = await runCli(["restart", ...options, "--json"], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
  });
  if (restart.status !== 0)
    throw new Error(
      `cloving restart failed: ${restart.stdout}${restart.stderr}`,
    );
  const lines = restart.stdout.trim().split("\n");
  return record(JSON.parse(lines.at(-1) ?? "null"))?.["turns"];
}
