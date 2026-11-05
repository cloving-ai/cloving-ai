import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { queuePrelude } from "./daemon-queue-fixture.ts";
import { productRoot } from "./world-host-fixture.ts";

export const workflow = `
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
export async function develop() {
  "use workflow";
  await waitForDecision({ gateId: "bundle-question", kind: "question", prompt: "Continue this bundle?" });
  return { kind: "completed" };
}
`;

const bundleModule = JSON.stringify(
  pathToFileURL(join(productRoot, "tools/workflow-bundles.ts")).href,
);
const fixtureModule = JSON.stringify(
  pathToFileURL(join(productRoot, "test/service-fixture.ts")).href,
);

export const bundlePrelude = `${queuePrelude}
import { cpSync, mkdirSync } from "node:fs";
import { retainWorkflowBundle } from ${bundleModule};
import { digestOf } from ${fixtureModule};
mkdirSync("bundle-project");
for (const name of ["workflows", "artifacts"])
  cpSync(name, "bundle-project/" + name, { recursive: true, dereference: true });
for (const [name, contents] of Object.entries({ "package.json": '{"type":"module"}', "declarations.json": "[]", "dependencies.json": "{}" }))
  writeFileSync("bundle-project/" + name, contents);
const bundleDigest = await retainWorkflowBundle({ project: directory + "/bundle-project", repository: directory, directory: directory + "/workflow-bundles" });
const bundlePath = "workflow-bundles/" + bundleDigest;
const hooksReady = async () => until(async () => {
  const world = await getWorld();
  const runs = (await world.runs.list({})).data;
  return (await Promise.all(runs.map(async run => (await world.events.list({ runId: run.runId, resolveData: "none" })).data.some(event => event.eventType === "hook_created")))).every(Boolean);
});
`;

export const versionedWorkflow =
  `
import { appendFileSync } from "node:fs";
export const before = 1;
export async function finish() {
  "use step";
  appendFileSync("executions", "original-step\\n");
  return { kind: "completed", step: "original-step" };
}
` +
  workflow.replace(
    'return { kind: "completed" }',
    'return { ...await finish(), flow: "original-flow" }',
  );

export const chargedWorkflow = versionedWorkflow
  .replace("develop()", "develop(input)")
  .replace(
    "  await waitForDecision",
    `  const before = await protectedEffect({ scope: { phase: "bundle", operation: "before", round: 1 }, capability: "claude", method: "run-turn", target: input.cycleId, payload: "original-effect", units: 1 });
  if (before.kind !== "completed") return { kind: "blocked", reason: JSON.stringify(before) };
  await waitForDecision`,
  )
  .replace(
    "  return { ...await finish()",
    `  const after = await protectedEffect({ scope: { phase: "bundle", operation: "after", round: 1 }, capability: "claude", method: "run-turn", target: input.cycleId, payload: "original-effect", units: 1 });
  if (after.kind !== "completed") return { kind: "blocked", reason: JSON.stringify(after) };
  return { ...await finish()`,
  )
  .replace(
    "import { waitForDecision }",
    'import { protectedEffect } from "cloving/workflows/steps/protected-effect";\nimport { waitForDecision }',
  );

export const generationSettings = `
const projectDeclaration = { workflowId: "project", functionName: "project", effectLimit: 3, capabilities: ["claude", "github"], input: { maximumBytes: 4096, fields: { prompt: { type: "string" } } } };
const originalSettings = { bundleDigest, queueMilliseconds: undefined, declarations: [projectDeclaration], manifests: { ...settings.manifests, project: directory + "/develop.workflow.json" }, workflows: { ...settings.workflows, project: workflows.develop }, command: [process.execPath, directory + "/worker.mjs", directory + "/effects"] };
const projectRun = (commandId) => submitted(commandId, { workflowId: "project", source: "declared", submission: { prompt: "task" } });
`;

export const generationWorker = `
import { execFileSync } from "node:child_process";
execFileSync("git", ["init", "-q", "-b", "main"]);
writeFileSync("README.md", "fixture");
execFileSync("git", ["add", "README.md"]);
execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initialize"]);
writeFileSync("worker.mjs", \`import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);
appendFileSync(process.argv[2], prompt + "\\\\n");
console.log(JSON.stringify({ type: "result", is_error: false, result: "completed" }));\`);
`;

export const waitingGeneration = `${generationWorker}
const daemon = await launched(originalSettings);
try {
  const admitted = await projectRun("retained-project");
  assert.equal(admitted.kind, "run-admitted", JSON.stringify(admitted));
  const runId = admitted.runId;
  await until(async () => (await shown(runId)).state === "waiting_gate");
  await hooksReady();
  assert.deepEqual((await shown(runId)).budget, { limit: 3, spent: 1 });
  writeFileSync("retained-run.json", JSON.stringify({ runId, bundleDigest }));
} finally { await daemon.close(); }
process.exit(0);
`;

export const queuedGeneration = `${generationWorker}
const daemon = await launched({ ...originalSettings, handler: () => Promise.resolve(new Response("restart-before-start", { status: 503 })) });
try {
  const admitted = await projectRun("queued-project");
  assert.equal(admitted.kind, "run-admitted", JSON.stringify(admitted));
  const runId = admitted.runId;
  await until(async () => (await (await getWorld()).runs.list({})).data.length === 1);
  assert.deepEqual((await shown(runId)).budget, { limit: 3, spent: 0 });
  assert.equal(existsSync("effects"), false);
  writeFileSync("retained-run.json", JSON.stringify({ runId, bundleDigest }));
} finally { await daemon.close(); }
process.exit(0);
`;

export const retainedGeneration = `
cpSync(process.env.CURRENT_PROJECT, "current-project", { recursive: true, dereference: true, filter: (source) => !source.includes("node_modules") });
for (const name of ["package.json", "declarations.json", "dependencies.json"])
  cpSync("bundle-project/" + name, "current-project/" + name);
cpSync("develop.workflow.json", "current-project/develop.workflow.json");
const currentDigest = await retainWorkflowBundle({ project: directory + "/current-project", repository: directory, directory: directory + "/workflow-bundles" });
assert.notEqual(currentDigest, bundleDigest);
`;

export const currentGeneration = `${retainedGeneration}
const currentClient = await import("./current-project/artifacts/client.mjs");
const currentHandler = await import("./current-project/artifacts/flow.mjs");
`;

export const restartedGeneration = `
import { cpSync } from "node:fs";
import { retainWorkflowBundle } from ${bundleModule};
import { digestOf } from ${fixtureModule};
const { runId, bundleDigest } = JSON.parse(readFileSync("retained-run.json", "utf8"));
${generationSettings}
const removed = process.env.GENERATION === "removed";
${currentGeneration}
assert.equal(currentClient.develop.workflowId, workflows.develop.workflowId);
const { project: oldProject, ...builtins } = originalSettings.manifests;
const manifests = Object.fromEntries(Object.keys(removed ? builtins : originalSettings.manifests).map(name => [name, directory + "/current-project/develop.workflow.json"]));
const loaded = [];
const replays = [];
const sweep = process.env.RETENTION === undefined ? {} : { retention: { days: 30, action: process.env.RETENTION, archiveFolder: null }, retentionClock: () => Date.now() + 40 * 86400000 };
cpSync("bundle-project", "free-project", { recursive: true });
writeFileSync("free-project/declarations.json", "[ ]");
const freeDigest = await retainWorkflowBundle({ project: directory + "/free-project", repository: directory, directory: directory + "/workflow-bundles" });
const daemon = await launched({ ...originalSettings, ...sweep, bundleDigest: currentDigest, manifests, declarations: removed ? [] : [projectDeclaration], workflows: { developTicket: currentClient.develop, developPrd: currentClient.develop, ...(removed ? {} : { project: currentClient.develop }) }, handler: currentHandler.POST, loadBundle: async (directory) => { loaded.push(directory); const bundle = await loadWorkflowBundle(directory); return { ...bundle, handler: async (request) => { const receipt = (await request.clone().json()).runId; const response = await bundle.handler(request); replays.push({ receipt, status: response.status }); return response; } }; } });
try {
  assert.deepEqual(loaded, [directory + "/workflow-bundles/" + bundleDigest]);
  assert.equal(existsSync("workflow-bundles/" + freeDigest), process.env.RETENTION === undefined);
  for (const kept of [bundleDigest, currentDigest]) assert.equal(existsSync("workflow-bundles/" + kept + "/bundle.json"), true);
  await until(async () => (await shown(runId)).state === "waiting_gate");
  assert.deepEqual((await shown(runId)).budget, { limit: 3, spent: 1 });
  const answer = { command: "answer", reference: runId + "/bundle-question", text: "Continue.", subjectDigest: digestOf("Continue this bundle?"), expectedRevision: 1, generation: 1, commandId: "answer" };
  assert.equal((await asked("decision", answer)).kind, "decision-recorded");
  assert.equal((await asked("decision", answer)).kind, "decision-recorded");
  await until(async () => (await shown(runId)).state === "completed");
  assert.deepEqual((await shown(runId)).budget, { limit: 3, spent: 2 });
  assert.equal(readFileSync("executions", "utf8"), "original-step\\n");
  assert.equal(readFileSync("effects", "utf8"), "original-effect\\noriginal-effect\\n");
  const world = await getWorld();
  await until(async () => (await world.runs.list({})).data.every(run => run.status === "completed"));
  const worlds = (await world.runs.list({})).data;
  for (const run of worlds) {
    const completions = () => replays.filter(replay => replay.receipt === run.runId);
    const before = completions().length;
    await world.queue("__wkf_workflow_" + run.workflowName, { runId: run.runId });
    await until(() => completions().length > before);
    assert.equal(completions().at(-1).status, 200);
  }
  assert.equal((await asked("decision", answer)).kind, "decision-recorded");
  assert.deepEqual((await shown(runId)).budget, { limit: 3, spent: 2 });
  assert.equal(readFileSync("effects", "utf8"), "original-effect\\noriginal-effect\\n");
  assert.equal(readFileSync("executions", "utf8"), "original-step\\n");
  assert.equal((await world.runs.list({})).data.length, 1);
  const admitted = await projectRun("fresh-project");
  if (removed) {
    assert.equal(admitted.code, "unknown-workflow", JSON.stringify(admitted));
    assert.equal((await world.runs.list({})).data.length, 1);
  } else {
    assert.equal(admitted.kind, "run-admitted", JSON.stringify(admitted));
    await until(async () => (await shown(admitted.runId)).state === "waiting_gate");
    assert.equal((await asked("decision", { ...answer, reference: admitted.runId + "/bundle-question", commandId: "current-answer" })).kind, "decision-recorded");
    await until(async () => (await shown(admitted.runId)).state === "completed");
    assert.deepEqual((await shown(admitted.runId)).budget, { limit: 3, spent: 2 });
    assert.equal(readFileSync("executions", "utf8"), "original-step\\ncurrent-step\\n");
    assert.equal(readFileSync("effects", "utf8"), "original-effect\\noriginal-effect\\ncurrent-effect\\ncurrent-effect\\n");
  }
  assert.deepEqual((await shown(runId)).budget, { limit: 3, spent: 2 });
} finally { await daemon.close(); }
process.exit(0);
`;
