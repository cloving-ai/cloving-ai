import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { workflowBundleLoader } from "../tools/self-host-workflows.ts";
import {
  bundlePrelude,
  workflow,
  versionedWorkflow,
  currentGeneration,
} from "./daemon-bundle-fixture.ts";

for (const damage of ["missing", "damaged", "present"]) {
  await test(`CLV-161 the daemon pins and checks a ${damage} bundle for a compiled waiting workflow`, () =>
    withConsumer(workflow, async (consumer) => {
      const result = await consumer.run(`${bundlePrelude}
const daemon = await launched({ bundleDigest, queueMilliseconds: undefined });
let pin;
try {
  const admitted = await submitted("bundle");
  pin = admitted.binding.workflowPin;
  const runId = admitted.runId;
  await until(async () => (await shown(runId)).state === "waiting_gate");
  await until(async () => (await (await getWorld()).runs.list({})).data.every(run => run.status === "completed"));
  const damage = ${JSON.stringify(damage)};
  if (damage === "missing") rmSync(bundlePath, { recursive: true });
  if (damage === "damaged") writeFileSync(bundlePath + "/artifacts/flow.mjs", "damaged");
  const answer = await asked("decision", { command: "answer", reference: runId + "/bundle-question", text: "Continue.", subjectDigest: digestOf("Continue this bundle?"), expectedRevision: 1, generation: 1, commandId: "answer" });
  assert.equal(answer.kind, "decision-recorded", JSON.stringify(answer));
  await until(async () => { const run = await shown(runId); return run.state === "completed" || run.reason.code === "pinned-workflow-unavailable"; });
  const shownRun = await shown(runId);
  const worlds = await (await getWorld()).runs.list({});
  assert.equal(worlds.data.length, damage === "present" ? 2 : 1);
  if (damage === "present") assert.equal(shownRun.state, "completed");
  else assert.equal(shownRun.reason.code, "pinned-workflow-unavailable");
} finally { await daemon.close(); }
const database = new DatabaseSync(directory + "/state/authority.sqlite", { readOnly: true });
const stored = database.prepare("SELECT pin, manifest FROM definitions").get();
database.close();
assert.equal(JSON.parse(stored.manifest).bundleDigest, bundleDigest);
assert.equal(stored.pin, pin);
process.exit(0);
`);
      assert.equal(result.status, 0, result.stderr);
    }));
}

await test("CLV-162 startup loads an unfinished run's retained code before continuing it beside edited code", () =>
  withConsumer(versionedWorkflow, async (original) =>
    withConsumer(
      versionedWorkflow.replaceAll("original-", "current-"),
      async (current) => {
        const result = await original.run(
          `${bundlePrelude}${workflowBundleLoader()}
const first = await launched({ bundleDigest, queueMilliseconds: undefined });
const admitted = await submitted("original");
const runId = admitted.runId;
await until(async () => (await shown(runId)).state === "waiting_gate");
await until(async () => (await (await getWorld()).runs.list({})).data.every(run => run.status === "completed"));
await first.close();
${currentGeneration}
const manifests = { developTicket: directory + "/current-project/develop.workflow.json", developPrd: directory + "/current-project/develop.workflow.json", develop: directory + "/current-project/develop.workflow.json" };
const loaded = [];
const daemon = await launched({ bundleDigest: currentDigest, manifests, queueMilliseconds: undefined, workflows: { developTicket: currentClient.develop, developPrd: currentClient.develop, develop: currentClient.develop }, handler: currentHandler.POST, loadBundle: async (directory) => { loaded.push(directory); return await loadWorkflowBundle(directory); } });
try {
  assert.deepEqual(loaded, [directory + "/" + bundlePath]);
  const answer = await asked("decision", { command: "answer", reference: runId + "/bundle-question", text: "Continue.", subjectDigest: digestOf("Continue this bundle?"), expectedRevision: 1, generation: 1, commandId: "answer" });
  assert.equal(answer.kind, "decision-recorded", JSON.stringify(answer));
  await until(async () => { const run = await shown(runId); return run.state === "completed" || run.reason.code === "pinned-workflow-unavailable"; });
  assert.equal((await shown(runId)).state, "completed", JSON.stringify(await shown(runId)));
  const currentRun = (await submitted("current")).runId;
  await until(async () => (await shown(currentRun)).state === "waiting_gate");
  const currentAnswer = await asked("decision", { command: "answer", reference: currentRun + "/bundle-question", text: "Continue.", subjectDigest: digestOf("Continue this bundle?"), expectedRevision: 1, generation: 1, commandId: "current-answer" });
  assert.equal(currentAnswer.kind, "decision-recorded");
  await until(async () => (await shown(currentRun)).state === "completed");
  await until(async () => (await (await getWorld()).runs.list({})).data.every(run => run.status === "completed"));
  const values = await Promise.all((await (await getWorld()).runs.list({})).data.map(run => getRun(run.runId).returnValue));
  assert.deepEqual(values.map(value => value.flow).filter(Boolean).sort(), ["current-flow", "original-flow"]);
  assert.equal(readFileSync("executions", "utf8"), "original-step\\ncurrent-step\\n");
} finally { await daemon.close(); }
process.exit(0);
`,
          { CURRENT_PROJECT: current.directory },
        );
        assert.equal(result.status, 0, result.stderr);
      },
    ),
  ));
