import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { workflowBundleLoader } from "../tools/self-host-workflows.ts";
import {
  bundlePrelude,
  retainedGeneration,
  versionedWorkflow,
  workflow,
} from "./daemon-bundle-fixture.ts";

const reloadPrelude = `
const reloadLines = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { reloadLines.push(String(chunk)); return write(chunk, ...rest); };
writeFileSync("reload.mjs", 'import { readFileSync } from "node:fs"; const reply = readFileSync(process.argv[2], "utf8"); process.stdout.write(reply); if (reply.includes("error")) process.exit(1);');
const reloadCommand = [process.execPath, directory + "/reload.mjs", directory + "/reload.json"];
const prepared = (fields) => writeFileSync("reload.json", JSON.stringify({ workflows: [], repository: directory, manifests: settings.manifests, declarations: settings.declarations, workflowRefusals: [], turnSettings: { profiles: {}, fallbackModels: [], tokenPrices: {} }, settingDigests: {}, ...fields }));
const answer = (runId, commandId) => asked("decision", { command: "answer", reference: runId + "/bundle-question", text: "Continue.", subjectDigest: digestOf("Continue this bundle?"), expectedRevision: 1, generation: 1, commandId });
`;

await test("CLV-252 a reload moves new runs to the changed code, and an answer continues the earlier run on its kept code", () =>
  withConsumer(versionedWorkflow, async (original) =>
    withConsumer(
      versionedWorkflow.replaceAll("original-", "current-"),
      async (current) => {
        const result = await original.run(
          `${bundlePrelude}${workflowBundleLoader()}${reloadPrelude}
const loaded = [];
const daemon = await launched({ bundleDigest, queueMilliseconds: undefined, reloadCommand, loadBundle: async (directory) => { loaded.push(directory); return await loadWorkflowBundle(directory); } });
try {
  const runId = (await submitted("original")).runId;
  await until(async () => (await shown(runId)).state === "waiting_gate");
  await hooksReady();
${retainedGeneration}
  const manifests = Object.fromEntries(Object.keys(settings.manifests).map((name) => [name, directory + "/current-project/develop.workflow.json"]));
  prepared({ bundleDigest: currentDigest, manifests });
  const reloaded = await asked("reload");
  assert.deepEqual(reloaded, { schemaVersion: 1, kind: "reload", status: "reloaded", previousBundleDigest: bundleDigest, bundleDigest: currentDigest, workflows: ["develop"], workflowRefusals: [], reloadedFields: [], restartFields: [] });
  assert.deepEqual(loaded, [directory + "/workflow-bundles/" + currentDigest]);
  assert.equal((await asked("status")).bundleDigest, currentDigest);
  assert.equal((await answer(runId, "answer")).kind, "decision-recorded");
  await until(async () => (await shown(runId)).state === "completed");
  const currentRun = (await submitted("current")).runId;
  await until(async () => (await shown(currentRun)).state === "waiting_gate");
  assert.equal((await answer(currentRun, "current-answer")).kind, "decision-recorded");
  await until(async () => (await shown(currentRun)).state === "completed");
  await until(async () => (await (await getWorld()).runs.list({})).data.every(run => run.status === "completed"));
  const values = await Promise.all((await (await getWorld()).runs.list({})).data.map(run => getRun(run.runId).returnValue));
  assert.deepEqual(values.map(value => value.flow).filter(Boolean).sort(), ["current-flow", "original-flow"]);
  assert.equal(readFileSync("executions", "utf8"), "original-step\\ncurrent-step\\n");
  assert.deepEqual(loaded, [directory + "/workflow-bundles/" + currentDigest, directory + "/workflow-bundles/" + bundleDigest]);
  const unchanged = await asked("reload");
  assert.equal(unchanged.status, "unchanged", JSON.stringify(unchanged));
  assert.equal(unchanged.previousBundleDigest, currentDigest);
  assert.equal(loaded.length, 2);
  assert.deepEqual(reloadLines.filter(line => line.startsWith("Workflow reload")), ["Workflow reload: reloaded " + bundleDigest + " -> " + currentDigest + "\\n", "Workflow reload: unchanged " + currentDigest + " -> " + currentDigest + "\\n"]);
} finally { await daemon.close(); }
process.exit(0);
`,
          { CURRENT_PROJECT: current.directory },
        );
        assert.equal(result.status, 0, result.stderr);
      },
    ),
  ));

await test("CLV-252 a refused reload keeps the workflows and the bundle digest and replies with the reason", () =>
  withConsumer(workflow, async (consumer) => {
    const result =
      await consumer.run(`${bundlePrelude}${workflowBundleLoader()}${reloadPrelude}
const startDigest = "0".repeat(64);
const kept = { scope: "project", label: "kept.ts", codes: ["compile-failed"] };
const daemon = await launched({ bundleDigest: startDigest, queueMilliseconds: undefined, workflowRefusals: [kept], reloadCommand, loadBundle: loadWorkflowBundle });
try {
  const refusals = [];
  const refusal = async (fields) => {
    if (typeof fields === "string") writeFileSync("reload.json", fields);
    else prepared(fields);
    const reply = await asked("reload");
    refusals.push([reply.code, reply.detail]);
  };
  await refusal({ bundleDigest, declarations: settings.declarations.map((declaration) => ({ ...declaration, queue: false })) });
  await refusal({ bundleDigest, declarations: [] });
  await refusal({ error: "The workflows did not compile." });
  await refusal("no bundle");
  await refusal({ bundleDigest: "e".repeat(64) });
  await refusal({ bundleDigest, manifests: {} });
  await refusal({ bundleDigest, manifests: { develop: 1 }, declarations: [1] });
  await refusal({ bundleDigest, workflowRefusals: [kept, { scope: "project", label: "develop.ts", codes: ["compile-failed"] }] });
  prepared({ bundleDigest: startDigest, workflowRefusals: [] });
  assert.equal((await asked("reload")).status, "unchanged");
  assert.deepEqual((await asked("status")).workflowRefusals, []);
  await refusal({ bundleDigest: startDigest, workflowRefusals: [kept] });
  assert.deepEqual(refusals.map(([code]) => code), ["reload-needs-restart", "reload-needs-restart", "reload-failed", "reload-failed", "reload-failed", "reload-failed", "reload-failed", "reload-failed", "reload-failed"]);
  assert.equal(refusals[7][1], "The reload gives new workflow refusals: project develop.ts: compile-failed");
  assert.equal(refusals[8][1], "The reload gives new workflow refusals: project kept.ts: compile-failed");
  assert.equal(refusals[6][1], "The reload command printed no workflow bundle.");
  assert.equal(refusals[2][1], "The workflows did not compile.");
  assert.equal(refusals[3][1], "The reload command printed no workflow bundle.");
  assert.match(refusals[4][1], /^The new bundle did not load/);
  assert.match(refusals[5][1], /Missing manifest for workflow function develop/);
  const status = await asked("status");
  assert.deepEqual(status.workflows, ["develop"]);
  assert.equal(status.bundleDigest, startDigest);
  assert.deepEqual(status.workflowRefusals, []);
  assert.equal(reloadLines.filter(line => line.startsWith("Workflow reload: refused ")).length, 9);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-252 a reload that changes the interval or the input of a schedule needs a restart", () =>
  withConsumer(workflow, async (consumer) => {
    const result =
      await consumer.run(`${bundlePrelude}${workflowBundleLoader()}${reloadPrelude}
const review = { workflowId: "review-queue", functionName: "review", effectLimit: 1, capabilities: ["claude", "github"], input: { maximumBytes: 1000, fields: { reason: { type: "string" } } }, schedule: { everySeconds: 300, input: { reason: "scheduled scan" } } };
const manifests = { ...settings.manifests, review: settings.manifests.developTicket };
const daemon = await launched({ bundleDigest: "0".repeat(64), queueMilliseconds: undefined, scheduleClock: () => 0, declarations: [review], manifests, workflows: { ...settings.workflows, review: workflows.develop }, reloadCommand, loadBundle: loadWorkflowBundle });
try {
  const codes = [];
  for (const schedule of [{ everySeconds: 600, input: { reason: "scheduled scan" } }, { everySeconds: 300, input: { reason: "changed" } }]) {
    prepared({ bundleDigest, manifests, declarations: [{ ...review, schedule }] });
    codes.push((await asked("reload")).code);
  }
  assert.deepEqual(codes, ["reload-needs-restart", "reload-needs-restart"]);
  prepared({ bundleDigest, manifests, declarations: [review] });
  const reloaded = await asked("reload");
  assert.equal(reloaded.status, "reloaded", JSON.stringify(reloaded));
  assert.deepEqual(reloaded.workflows, ["review-queue"]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-252 a reload without workflow files removes the last workflow, and its waiting run continues on its kept code", () =>
  withConsumer(workflow, async (consumer) => {
    const result =
      await consumer.run(`${bundlePrelude}${workflowBundleLoader()}${reloadPrelude}
cpSync("bundle-project", "empty-project", { recursive: true });
writeFileSync("empty-project/empty.json", "{}");
const emptyDigest = await retainWorkflowBundle({ project: directory + "/empty-project", repository: directory, directory: directory + "/workflow-bundles" });
const declarations = settings.declarations.map((declaration) => ({ ...declaration, queue: false }));
const daemon = await launched({ bundleDigest, queueMilliseconds: undefined, declarations, reloadCommand, loadBundle: loadWorkflowBundle });
try {
  const runId = (await submitted("before-reload")).runId;
  await until(async () => (await shown(runId)).state === "waiting_gate");
  await hooksReady();
  prepared({ bundleDigest: emptyDigest, manifests: {}, declarations: [] });
  const reloaded = await asked("reload");
  assert.deepEqual(reloaded, { schemaVersion: 1, kind: "reload", status: "reloaded", previousBundleDigest: bundleDigest, bundleDigest: emptyDigest, workflows: [], workflowRefusals: [], reloadedFields: [], restartFields: [] });
  assert.deepEqual((await asked("status")).workflows, []);
  const removed = await submitted("after-reload");
  assert.equal(removed.code, "unknown-workflow", JSON.stringify(removed));
  assert.equal((await answer(runId, "answer")).kind, "decision-recorded");
  await until(async () => (await shown(runId)).state === "completed");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-253 a reload refuses a settings refusal, invalid turn settings and a profile harness with no worker, and keeps a restart field at its start digest", () =>
  withConsumer(workflow, async (consumer) => {
    const result =
      await consumer.run(`${bundlePrelude}${workflowBundleLoader()}${reloadPrelude}
const daemon = await launched({ bundleDigest, queueMilliseconds: undefined, settingDigests: { profiles: "a", "queue.lanes": "b", "watch.port": "c" }, reloadCommand, loadBundle: loadWorkflowBundle });
try {
  const turns = (fields) => ({ turnSettings: { profiles: {}, fallbackModels: [], tokenPrices: {}, ...fields } });
  const refusals = [];
  for (const fields of [
    { refusal: { code: "invalid-config-json", detail: "invalid-config-json: private" } },
    { turnSettings: null },
    turns({ fallbackModels: "one" }),
    turns({ profiles: "none" }),
    { settingDigests: { profiles: 1 } },
    { settingDigests: "none" },
    turns({ profiles: { review: { harness: "unknown" } } }),
    turns({ profiles: { review: { harness: "codex" } } }),
  ]) {
    prepared({ bundleDigest, ...fields });
    const reply = await asked("reload");
    refusals.push([reply.code, reply.detail]);
  }
  const printed = ["reload-failed", "The reload command printed no workflow bundle."];
  assert.deepEqual(refusals, [["invalid-config-json", "invalid-config-json: private"], printed, printed, printed, printed, printed, ["harness-no-worker", "harness-no-worker: unknown"], ["harness-no-worker", "harness-no-worker: codex"]]);
  prepared({ bundleDigest, ...turns({ profiles: { review: { harness: "claude", model: "new" } } }), settingDigests: { profiles: "d", "queue.lanes": "e", "watch.port": "c" } });
  const first = await asked("reload");
  assert.deepEqual([first.status, first.reloadedFields, first.restartFields], ["unchanged", ["profiles"], ["queue.lanes"]]);
  const second = await asked("reload");
  assert.deepEqual([second.status, second.reloadedFields, second.restartFields], ["unchanged", [], ["queue.lanes"]]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-294 a failed reload command with no bundle names its exit code and the end of its standard error", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${bundlePrelude}${workflowBundleLoader()}
const failing = [process.execPath, "-e", "process.stderr.write('x'.repeat(4096) + 'boom\\\\n'); process.exit(3)"];
const daemon = await launched({ bundleDigest, queueMilliseconds: undefined, reloadCommand: failing, loadBundle: loadWorkflowBundle });
try {
  const reply = await asked("reload");
  assert.equal(reply.code, "reload-failed");
  assert.equal(reply.detail, "The reload command printed no workflow bundle. It exited with code 3: " + "x".repeat(2044) + "boom");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
