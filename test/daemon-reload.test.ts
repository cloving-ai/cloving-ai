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
const prepared = (fields) => writeFileSync("reload.json", JSON.stringify({ workflows: [], repository: directory, manifests: settings.manifests, declarations: settings.declarations, workflowRefusals: [], ...fields }));
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
  assert.deepEqual(reloaded, { schemaVersion: 1, kind: "reload", status: "reloaded", previousBundleDigest: bundleDigest, bundleDigest: currentDigest, workflows: ["develop"], workflowRefusals: [] });
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
const daemon = await launched({ bundleDigest: startDigest, queueMilliseconds: undefined, reloadCommand, loadBundle: loadWorkflowBundle });
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
  assert.deepEqual(refusals.map(([code]) => code), ["reload-needs-restart", "reload-no-workflow", "reload-failed", "reload-failed", "reload-failed", "reload-failed", "reload-failed"]);
  assert.equal(refusals[6][1], "The reload command printed no workflow bundle.");
  assert.equal(refusals[2][1], "The workflows did not compile.");
  assert.equal(refusals[3][1], "The reload command printed no workflow bundle.");
  assert.match(refusals[4][1], /^The new bundle did not load/);
  assert.match(refusals[5][1], /Missing manifest for workflow function develop/);
  const status = await asked("status");
  assert.deepEqual(status.workflows, ["develop"]);
  assert.equal(status.bundleDigest, startDigest);
  assert.equal(reloadLines.filter(line => line.startsWith("Workflow reload: refused ")).length, 7);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
