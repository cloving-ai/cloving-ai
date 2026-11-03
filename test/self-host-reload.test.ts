import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { record, type Fields } from "../src/protocol.ts";
import {
  answeredOperator,
  operatorQuestion,
} from "./operator-restart-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  field,
  reached,
  scene,
  withoutChildren,
  type Scene,
} from "./self-host-fixture.ts";
import { call, runCli } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

const product = join(import.meta.dirname, "..");

const brokenSource =
  'export async function broken() { "use workflow"; const value: number = "text"; return value; }';

const brokenDeclaration = JSON.stringify({
  ...candidateDeclaration,
  workflow: { ...candidateDeclaration.workflow, workflowId: "broken" },
});

async function operatorWorkflow(
  folder: string,
  workflow: { readonly name: string; readonly prompt: string },
): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, `${workflow.name}.ts`),
    `
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
export async function ${workflow.name}Operator() {
  "use workflow";
  const decision = await waitForDecision({ gateId: "operator-answer", kind: "question", prompt: ${JSON.stringify(workflow.prompt)} });
  return { kind: decision.decision === "answered" ? "handoff_requested" : "blocked", reason: ${JSON.stringify(workflow.prompt)} };
}`,
  );
  await writeFile(
    join(folder, `${workflow.name}.declaration.json`),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: { ...candidateDeclaration.workflow, workflowId: workflow.name },
    }),
  );
}

async function tree(folder: string): Promise<readonly string[]> {
  const entries = await readdir(folder, { recursive: true });
  const shown = [];
  for (const entry of entries.sort()) {
    const status = await lstat(join(folder, entry));
    shown.push(`${entry} ${String(status.size)} ${String(status.mtimeMs)}`);
  }
  return shown;
}

function executed(argumentsList: readonly string[]) {
  return spawnSync(process.execPath, argumentsList, {
    encoding: "utf8",
    timeout: testMilliseconds(90_000),
  });
}

function printed(argumentsList: readonly string[]) {
  const result = executed(argumentsList);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reply = record(JSON.parse(result.stdout));
  assert.ok(reply);
  return reply;
}

function reloaded(settings: Readonly<Record<string, string>>) {
  return printed([
    join(product, "tools/self-host-reload.ts"),
    JSON.stringify(settings),
  ]);
}

function started(settings: Readonly<Record<string, string>>) {
  const module = pathToFileURL(join(product, "tools/self-host-project.ts"));
  return printed([
    "--input-type=module",
    "-e",
    `import { preparedProject } from ${JSON.stringify(module.href)};
process.stdout.write(JSON.stringify(await preparedProject(${JSON.stringify(settings)})));`,
  ]);
}

await test("CLV-252 the reload program prepares a bundle beside the start project and never writes into it", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const repository = join(root, "repo");
    const folder = join(repository, ".cloving/workflows");
    const directory = join(root, "host");
    await operatorWorkflow(folder, { name: "develop", prompt: "v1" });
    const start = started({
      product,
      project: join(directory, "project"),
      repository,
      home: root,
      xdgConfigHome: join(root, "config"),
    });
    const startDigest = String(start["bundleDigest"]);
    const before = await tree(join(directory, "project"));
    const settings = {
      directory,
      repository,
      home: root,
      xdgConfigHome: join(root, "config"),
    };
    const same = reloaded(settings);
    assert.equal(same["bundleDigest"], startDigest);
    const manifest = String(record(same["manifests"])?.["developOperator"]);
    assert.equal(
      dirname(manifest),
      join(directory, "workflow-bundles", startDigest),
    );
    assert.ok((await lstat(manifest)).isFile());
    await writeFile(join(folder, "broken.ts"), brokenSource);
    await writeFile(join(folder, "broken.declaration.json"), brokenDeclaration);
    const refused = reloaded(settings);
    assert.equal(refused["bundleDigest"], startDigest);
    assert.deepEqual(refused["workflowRefusals"], [
      { scope: "project", label: "broken.ts", codes: ["compile-failed"] },
    ]);
    await operatorWorkflow(folder, { name: "triage", prompt: "triage" });
    const added = reloaded(settings);
    assert.notEqual(added["bundleDigest"], startDigest);
    assert.deepEqual(Object.keys(record(added["manifests"]) ?? {}).sort(), [
      "developOperator",
      "triageOperator",
    ]);
    assert.deepEqual(await tree(join(directory, "project")), before);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith("reload-")),
      [],
    );
  }));

await test("CLV-252 the reload program prints the reason when it cannot prepare a bundle", () =>
  withFiles({ "host/marker": "" }, (root) => {
    const program = join(product, "tools/self-host-reload.ts");
    const unsettled = executed([program, "null"]);
    assert.equal(unsettled.status, 1);
    assert.match(unsettled.stderr, /needs the start setting directory/);
    const failed = executed([
      program,
      JSON.stringify({ directory: join(root, "host"), home: root }),
    ]);
    assert.equal(failed.status, 1, failed.stderr);
    assert.deepEqual(JSON.parse(failed.stdout), {
      error: "Error: The reload program needs the start setting repository.",
    });
    assert.deepEqual(readdirSync(join(root, "host")), ["marker"]);
  }));

const standInTurn = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
for await (const chunk of process.stdin) void chunk;
writeFileSync(join(import.meta.dirname, "turn-started"), "");
while (!existsSync(join(import.meta.dirname, "release-turn"))) await delay(50);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
line({ type: "result", subtype: "success", is_error: false, result: "The turn is done.", total_cost_usd: 0.01, session_id: "session-1", num_turns: 1 });
`;

async function turnWorkflow(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "develop.ts"),
    `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function developTurn(input: { cycleId: string }) {
  "use workflow";
  const turn = await protectedEffect({ scope: { phase: "develop", operation: "turn", round: 1 }, capability: "claude", method: "run-turn", target: input.cycleId, payload: "Do the stand-in turn.", units: 1 });
  return { kind: turn.kind === "completed" ? "handoff_requested" : "blocked", reason: "develop" };
}`,
  );
  await writeFile(
    join(folder, "develop.declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: { ...candidateDeclaration.workflow, workflowId: "develop" },
    }),
  );
}

interface Started {
  readonly fixture: Scene;
  readonly folder: string;
}

function asked(
  fixture: Scene,
  request: { readonly operation: string; readonly parameters: Fields },
) {
  return call(fixture, request);
}

function submitted(fixture: Scene, workflowId: string) {
  return asked(fixture, {
    operation: "run",
    parameters: {
      workflowId,
      source: "declared",
      commandId: `${workflowId}-${String(Date.now())}`,
      submission: {},
    },
  });
}

async function state(fixture: Scene, runId: string): Promise<unknown> {
  const status = await asked(fixture, {
    operation: "status",
    parameters: { runId },
  });
  return field(status["run"], "state");
}

async function reloadReply(
  fixture: Scene,
  argumentsList: readonly string[],
): Promise<{ readonly stdout: string; readonly reply: Fields }> {
  const result = await runCli(["reload", ...argumentsList], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return {
    stdout: result.stdout,
    reply: argumentsList.includes("--json")
      ? (record(JSON.parse(result.stdout)) ?? {})
      : {},
  };
}

async function addedDuringTurn(started: Started, startDigest: unknown) {
  const { fixture, folder } = started;
  const turn = await submitted(fixture, "develop");
  assert.equal(turn["kind"], "run-admitted", JSON.stringify(turn));
  const turnRun = String(turn["runId"]);
  await reached(() =>
    Promise.resolve(
      existsSync(join(fixture.root, "turn-started")) ? true : undefined,
    ),
  );
  await operatorWorkflow(folder, { name: "triage", prompt: "triage" });
  const { reply } = await reloadReply(fixture, ["--json"]);
  assert.equal(reply["status"], "reloaded");
  assert.equal(reply["previousBundleDigest"], startDigest);
  assert.deepEqual(reply["workflows"], ["develop", "triage"]);
  assert.deepEqual(reply["workflowRefusals"], []);
  const triage = await submitted(fixture, "triage");
  assert.equal(triage["kind"], "run-admitted", JSON.stringify(triage));
  const triageRun = String(triage["runId"]);
  await operatorQuestion(fixture, triageRun);
  assert.notEqual(await state(fixture, turnRun), "completed");
  await writeFile(join(fixture.root, "release-turn"), "");
  await reached(async () =>
    (await state(fixture, turnRun)) === "completed" ? true : undefined,
  );
  return { triageRun, bundleDigest: reply["bundleDigest"] };
}

async function keptAfterFailure(started: Started, bundleDigest: unknown) {
  const { fixture, folder } = started;
  await writeFile(join(folder, "broken.ts"), brokenSource);
  await writeFile(join(folder, "broken.declaration.json"), brokenDeclaration);
  const { stdout } = await reloadReply(fixture, []);
  assert.match(stdout, /^Reload: unchanged$/m);
  assert.match(stdout, /^ {2}project broken\.ts: compile-failed$/m);
  const status = await asked(fixture, { operation: "status", parameters: {} });
  assert.deepEqual(status["workflows"], ["develop", "triage"]);
  assert.equal(status["bundleDigest"], bundleDigest);
}

async function removedWhileWaiting(started: Started, triageRun: string) {
  const { fixture, folder } = started;
  for (const name of ["triage", "broken"])
    for (const file of [`${name}.ts`, `${name}.declaration.json`])
      await rm(join(folder, file));
  const { reply } = await reloadReply(fixture, ["--json"]);
  assert.equal(reply["status"], "reloaded");
  const refused = await submitted(fixture, "triage");
  assert.equal(refused["code"], "unknown-workflow", JSON.stringify(refused));
  await answeredOperator(fixture, { runId: triageRun, version: "triage" });
}

await test("CLV-252 cloving reload admits a new workflow while a run is in a stand-in turn, keeps a failed file out and removes a workflow", () =>
  withoutChildren(async () => {
    const fixture = await scene(standInTurn);
    const started = {
      fixture,
      folder: join(fixture.repository, ".cloving/workflows"),
    };
    await turnWorkflow(started.folder);
    const child = await fixture.start({
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CLOVING_SELF_UPDATE_SECONDS: undefined,
      CLOVING_NOTIFY_COMMAND: "[]",
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const project = join(fixture.directory, "project");
    const before = await tree(project);
    const startDigest = (
      await asked(fixture, { operation: "status", parameters: {} })
    )["bundleDigest"];
    const added = await addedDuringTurn(started, startDigest);
    await keptAfterFailure(started, added.bundleDigest);
    await removedWhileWaiting(started, added.triageRun);
    assert.deepEqual(await tree(project), before);
    assert.match(
      output,
      new RegExp(`Workflow reload: reloaded ${String(startDigest)} -> `),
    );
  }));
