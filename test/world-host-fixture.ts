import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const productRoot = join(import.meta.dirname, "..");

export const hostModule = pathToFileURL(
  join(productRoot, "src/host/world-host.ts"),
).href;

export const prelude = `
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { getRun, start } from "workflow/api";
import { getWorld, setWorld } from "workflow/runtime";
import * as workflows from "./artifacts/client.mjs";
import { POST } from "./artifacts/flow.mjs";
import { startHost } from ${JSON.stringify(hostModule)};
const dataDirectory = process.env.WORKFLOW_LOCAL_DATA_DIR;
const print = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const halt = (boundary, detail = {}) => { print({ boundary, ...detail }); setInterval(() => undefined, 60000); return new Promise(() => undefined); };
const worlds = () => ["cache", "stubbedCache", "cachePromise", "stubbedCachePromise"].filter((name) => globalThis[Symbol.for("@workflow/world//" + name)] !== undefined).length;
`;

const product = (file: string): string =>
  JSON.stringify(pathToFileURL(join(productRoot, file)).href);

export const servicePrelude = `
import { mkdirSync } from "node:fs";
import { startService } from ${product("src/service/service.ts")};
import { startDelivery } from ${product("src/host/start-delivery.ts")};
import { cancelled, outcomeKind, taggedRuns } from ${product("src/host/world-runs.ts")};
import { worldLoop } from ${product("src/host/world-reconciliation.ts")};
import { call, digestOf, fakeRegistration, testTiming } from ${product("test/service-fixture.ts")};
const stateDirectory = process.cwd() + "/state";
const runtimeDirectory = process.cwd() + "/runtime";
mkdirSync(stateDirectory, { recursive: true });
mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
const asked = (operation, parameters) => call({ runtimeDirectory }, { operation, parameters });
const eventTypes = async (runId) => (await asked("events", { after: 0, limit: 1000, runId })).events.map((event) => event.type);
const stateOf = async (runId) => (await asked("status", { runId })).run.state;
const until = async (reached) => { for (let pass = 0; pass < 500; pass += 1) { if (await reached()) return; await delay(20); } throw new Error("The scenario did not reach its state."); };
let ports;
const calls = [];
const recording = (product) => ({
  reconcile: async (intent) => { const outcome = await product.reconcile(intent); calls.push("reconcile " + outcome.kind); return outcome; },
  deliver: async (intent) => { calls.push("deliver"); return await product.deliver(intent); },
  stop: async (intent) => { const outcome = await product.stop(intent); calls.push("stop " + outcome.kind); return outcome; },
});
const hosted = async (overrides = {}) => {
  const product = startDelivery({
    runs: taggedRuns,
    input: (runId) => ports.input(runId),
    document: (digest) => ports.document(digest),
    workflow: async (runId) => workflows[await ports.workflowId(runId)],
    cancel: cancelled,
  });
  const delivery = (overrides.wrap ?? recording)(product);
  const opening = await startService({
    stateDirectory,
    runtimeDirectory,
    workflows: [fakeRegistration([])],
    delivery,
    timing: testTiming,
    host: async (given) => {
      ports = given;
      const host = await startHost({ dataDirectory, concurrency: 1, handler: POST });
      if (host.kind !== "started") throw new Error(host.reason);
      const loop = worldLoop({ ...given, runs: taggedRuns, outcome: outcomeKind, intervalMilliseconds: 20, ...overrides.loop });
      return { close: async () => { await loop.stop(); await host.host.close(); }, reports: loop.reports };
    },
  });
  if (opening.kind !== "started") { print(opening); process.exit(3); }
  globalThis.clovingGate = async (worldRunId) => {
    const runId = (await taggedRuns()).find((run) => run.receipt === worldRunId).runId;
    const opened = Object.values((await ports.state()).gates).some((gate) => gate.runId === runId && gate.gateId === "design-1");
    if (opened) return runId + "/design-1";
    await until(async () => (await ports.state()).runs[runId].status === "running");
    const prompt = "question of " + runId;
    await opening.service.worker.openGate({ runId, commandId: "open:" + worldRunId, expectedRevision: (await ports.state()).runs[runId].revision, gateId: "design-1", kind: "question", prompt, subject: digestOf(prompt) });
    while (existsSync("hold-wait")) await delay(10);
    await opening.service.worker.registerWait({ runId, commandId: "wait:" + worldRunId, gateId: "design-1" });
    return runId + "/design-1";
  };
  return opening.service;
};
const answered = async (runId, overrides = {}) => (await asked("decision", { command: "answer", reference: runId + "/design-1", text: "Use the table parser.", subjectDigest: digestOf("question of " + runId), expectedRevision: 1, generation: 1, commandId: "c-answer", ...overrides }));
const segments = async () => {
  const found = (await tagged()).toSorted((first, second) => (first.receipt < second.receipt ? -1 : 1));
  const outputs = [];
  for (const run of found) outputs.push(run.status === "completed" ? await getRun(run.receipt).returnValue : null);
  return found.map((run, index) => ({ kind: JSON.parse(run.operation)[4], status: run.status, output: outputs[index] }));
};
const sends = () => calls.filter((call) => call === "deliver").length;
const submitted = async (commandId) => (await asked("run", { workflowId: "develop", source: "prompt", submission: { prompt: "task of " + commandId }, commandId })).runId;
const tagged = async () => (await taggedRuns()).map((run) => ({ run: run.runId, operation: run.operationId, receipt: run.receipt, status: run.status }));
const stepStarts = () => (existsSync("step-starts") ? readFileSync("step-starts", "utf8").split("\\n").length - 1 : 0);
const dispatches = async (runId) => (await asked("events", { after: 0, limit: 1000, runId })).events.filter((event) => event.type === "step.dispatched").map((event) => event.payload.receipt);
`;

export interface ChildResult {
  readonly status: number | null;
  readonly lines: readonly unknown[];
  readonly stderr: string;
}

export interface Consumer {
  readonly directory: string;
  readonly world: string;
  readonly run: (
    script: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ) => Promise<ChildResult>;
  readonly runUntil: (boundary: string, script: string) => Promise<ChildResult>;
}

function child(
  argumentsList: readonly string[],
  options: {
    readonly directory: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly boundary?: string;
  },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const started = spawn(process.execPath, argumentsList, {
      cwd: options.directory,
      env: { ...process.env, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    const output = { stdout: "", stderr: "" };
    started.stdout.on("data", (chunk: Buffer) => {
      output.stdout += chunk.toString();
      if (
        options.boundary !== undefined &&
        output.stdout.includes(`{"boundary":"${options.boundary}"`)
      )
        started.kill("SIGKILL");
    });
    started.stderr.on("data", (chunk: Buffer) => {
      output.stderr += chunk.toString();
    });
    started.on("error", reject);
    started.on("close", (status) => {
      resolve({
        status,
        stderr: output.stderr,
        lines: output.stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line): unknown => JSON.parse(line)),
      });
    });
  });
}

async function compiledConsumer(
  directory: string,
  workflow: string,
): Promise<void> {
  await mkdir(join(directory, "workflows"));
  await writeFile(
    join(directory, "package.json"),
    '{"name":"host-consumer","private":true,"type":"module"}',
  );
  await writeFile(join(directory, "workflows/develop.ts"), workflow);
  await symlink(
    join(productRoot, "node_modules"),
    join(directory, "node_modules"),
  );
  const compiled = await child(
    [join(productRoot, "tools/compile-workflows.ts"), "workflows", "artifacts"],
    { directory, environment: {} },
  );
  if (compiled.status !== 0)
    throw new Error(`The fixture workflow did not compile: ${compiled.stderr}`);
}

export async function withConsumer<Result>(
  workflow: string,
  use: (consumer: Consumer) => Promise<Result>,
): Promise<Result> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cloving-host-")),
  );
  const world = join(directory, "world");
  try {
    await compiledConsumer(directory, workflow);
    const environment = {
      WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_DATA_DIR: world,
      WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:1",
      WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "1",
      WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "2",
    };
    const scenario = async (script: string): Promise<void> => {
      await writeFile(join(directory, "scenario.mjs"), prelude + script);
    };
    return await use({
      directory,
      world,
      run: async (script, overrides = {}) => {
        await scenario(script);
        return await child(["scenario.mjs"], {
          directory,
          environment: { ...environment, ...overrides },
        });
      },
      runUntil: async (boundary, script) => {
        await scenario(script);
        return await child(["scenario.mjs"], {
          directory,
          environment,
          boundary,
        });
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
