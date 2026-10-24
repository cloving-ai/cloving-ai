import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { queuePrelude } from "./daemon-queue-fixture.ts";
import { productRoot, withConsumer } from "./world-host-fixture.ts";

const workflow = `
import { decisionGate } from "cloving/workflows/steps/decision-gate";
export async function develop(input, continuation) {
  "use workflow";
  if (continuation !== undefined) return { kind: "completed" };
  await decisionGate({ gateId: "bundle-question", kind: "question", prompt: "Continue this bundle?" });
  return { kind: "waiting_for_decision" };
}
`;

const bundleModule = JSON.stringify(
  pathToFileURL(join(productRoot, "tools/workflow-bundles.ts")).href,
);
const fixtureModule = JSON.stringify(
  pathToFileURL(join(productRoot, "test/service-fixture.ts")).href,
);

const bundlePrelude = `${queuePrelude}
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
`;

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
