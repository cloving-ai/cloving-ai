import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const productRoot = join(import.meta.dirname, "..");

export const hostModule = pathToFileURL(
  join(productRoot, "src/host/world-host.ts"),
).href;

export const prelude = `
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
import { cancelled, workflowOutcome, taggedRun, taggedRuns } from ${product("src/host/world-runs.ts")};
import { worldLoop } from ${product("src/host/world-reconciliation.ts")};
import { registerStepBridge, sdkStepCall, stepBridge } from ${product("src/host/step-bridge-host.ts")};
import { call, digestOf, fakeRegistration, testTiming } from ${product("test/service-fixture.ts")};
const stateDirectory = process.cwd() + "/state";
const runtimeDirectory = process.cwd() + "/runtime";
mkdirSync(stateDirectory, { recursive: true });
mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
const asked = (operation, parameters) => call({ runtimeDirectory }, { operation, parameters });
const eventTypes = async (runId) => (await asked("events", { after: 0, limit: 1000, runId })).events.map((event) => event.type);
const stateOf = async (runId) => (await asked("status", { runId })).run.state;
const until = async (reached) => { for (let pass = 0; pass < 1500; pass += 1) { if (await reached()) return; await delay(20); } throw new Error("The scenario did not reach its state."); };
let ports;
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter(Boolean) : []);
const holdAt = async (gate) => {
  if (!existsSync(gate)) return;
  writeFileSync(gate + "-entered", "");
  while (existsSync(gate)) await delay(10);
};
const effectOutcome = (operationId) => ({ kind: "completed", receipt: "receipt-" + String(lines("destination.log").indexOf(operationId) + 1), result: "effect-result" });
const destination = {
  deliver: async (intent) => {
    appendFileSync("destination.log", intent.operationId + "\\n");
    if (existsSync("halt-after-effect")) {
      await until(() => lines("requests.log").length > 0);
      await halt("halted-after-effect", { sends: lines("destination.log").length });
    }
    while (existsSync("hold-effect")) await delay(10);
    if (existsSync("lose-reply")) throw new Error("the reply is lost");
    return effectOutcome(intent.operationId);
  },
  reconcile: async (intent) => {
    appendFileSync("reconciles.log", intent.operationId + "\\n");
    if (!lines("destination.log").includes(intent.operationId)) return { kind: "absent" };
    return existsSync("not-idempotent") ? { kind: "unknown" } : effectOutcome(intent.operationId);
  },
};
const deliveryRows = (operationId) => {
  const database = new DatabaseSync(process.cwd() + "/state/authority.sqlite", { readOnly: true });
  try { return database.prepare("SELECT outcome, receipt FROM deliveries WHERE operation_id = ? ORDER BY staged_sequence").all(operationId).map((row) => [row.outcome, row.receipt]); } finally { database.close(); }
};
const checkpointBarrier = async () => {
  const world = await getWorld();
  const create = world.events.create.bind(world.events);
  world.events.create = async (...given) => {
    if (given[1]?.eventType === "step_completed" && existsSync("halt-at-checkpoint")) return await halt("halted-before-checkpoint", { sends: lines("destination.log").length, reconciles: lines("reconciles.log").length });
    return await create(...given);
  };
};
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
    workflow: async (runId) => overrides.workflow ?? workflows[await ports.workflowId(runId)],
    cancel: cancelled,
  });
  const runs = (overrides.wrap ?? recording)(product);
  const routed = (name) => (intent, signal) => (intent.kind === "protected-effect" ? (overrides.destination ?? destination) : runs)[name](intent, signal);
  const delivery = { deliver: routed("deliver"), reconcile: routed("reconcile"), stop: runs.stop };
  const opening = await startService({
    stateDirectory,
    runtimeDirectory,
    workflows: overrides.registrations ?? [{ ...fakeRegistration([]), effectLimit: Number(process.env.EFFECT_LIMIT ?? "5") }],
    delivery,
    effects: overrides.effects,
    timing: testTiming,
    host: async (given) => {
      ports = given;
      const host = await startHost({ dataDirectory, concurrency: 1, handler: POST });
      if (host.kind !== "started") throw new Error(host.reason);
      globalThis.released = host.host.released;
      const loop = worldLoop({ ...given, runs: taggedRuns, outcome: workflowOutcome, intervalMilliseconds: 20, ...overrides.loop });
      const requestEffect = async (request) => {
        const reply = await given.requestEffect(request);
        const lost = existsSync("fail-first-reply");
        appendFileSync("requests.log", JSON.stringify([reply.operation?.operationId ?? null, reply.operation?.inputDigest ?? null, request.commandId, lost ? "failed" : reply.receipt.kind]) + "\\n");
        await holdAt("hold-request");
        if (!lost) return reply;
        rmSync("fail-first-reply");
        if (existsSync("halt-after-failed")) setTimeout(() => halt("halted-after-failed-receipt"), 0);
        return { receipt: { kind: "failed", reason: "storage-failure" }, disposition: null, operation: null };
      };
      const stopping = new AbortController();
      const timing = { lookupTries: 250, pollMilliseconds: 20, retryMilliseconds: 100 };
      const registerWait = async (wait) => { if (existsSync("halt-before-wait")) await halt("halted-before-wait"); return await given.registerWait(wait); };
      const remove = registerStepBridge(stepBridge({ ...given, requestEffect, registerWait, run: taggedRun, call: sdkStepCall, stopped: stopping.signal, timing }));
      return { close: async () => { stopping.abort(); remove(); await loop.stop(); await host.host.close(); }, reports: loop.reports };
    },
  });
  if (opening.kind !== "started") { print(opening); process.exit(3); }
  globalThis.clovingGate = async (worldRunId) => {
    let found;
    await until(async () => (found = await taggedRun(worldRunId)) !== undefined);
    const runId = found.runId;
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
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        ...options.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
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

async function linkedPackages(directory: string): Promise<void> {
  const modules = join(directory, "node_modules");
  await mkdir(modules);
  for (const entry of await readdir(join(productRoot, "node_modules")))
    await symlink(
      join(productRoot, "node_modules", entry),
      join(modules, entry),
    );
  const manifest: unknown = JSON.parse(
    await readFile(join(productRoot, "package.json"), "utf8"),
  );
  const version: unknown = Reflect.get(Object(manifest), "version");
  const product = join(modules, "cloving");
  await cp(join(productRoot, "src"), join(product, "src"), { recursive: true });
  await writeFile(
    join(product, "package.json"),
    JSON.stringify({
      name: "cloving",
      version,
      type: "module",
      exports: {
        "./workflows": "./src/workflows.ts",
        "./workflows/steps/load-cycle": "./src/steps/load-cycle.ts",
        "./workflows/steps/protected-effect": "./src/steps/protected-effect.ts",
        "./workflows/steps/decision-gate": "./src/steps/decision-gate.ts",
      },
    }),
  );
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
  await linkedPackages(directory);
  const compiled = await child(
    [join(productRoot, "tools/compile-workflows.ts"), "workflows", "artifacts"],
    { directory, environment: {} },
  );
  if (compiled.status !== 0)
    throw new Error(`The fixture workflow did not compile: ${compiled.stderr}`);
}

const templates = new Map<string, Promise<string>>();

function template(workflow: string): Promise<string> {
  const known = templates.get(workflow);
  if (known !== undefined) return known;
  const made = mkdtemp(join(tmpdir(), "cloving-template-")).then(
    async (created) => {
      const directory = await realpath(created);
      process.on("exit", () => {
        rmSync(directory, { recursive: true, force: true });
      });
      await compiledConsumer(directory, workflow);
      return directory;
    },
  );
  templates.set(workflow, made);
  return made;
}

async function linkedConsumer(
  directory: string,
  workflow: string,
): Promise<void> {
  const source = await template(workflow);
  await writeFile(
    join(directory, "package.json"),
    '{"name":"host-consumer","private":true,"type":"module"}',
  );
  for (const name of ["artifacts", "node_modules", "workflows"])
    await symlink(join(source, name), join(directory, name));
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
    await linkedConsumer(directory, workflow);
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
