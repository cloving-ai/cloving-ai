import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { preparedProject } from "../tools/self-host-project.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import { queuePrelude } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { workflowBundleLoader } from "../tools/self-host-workflows.ts";

const workflow = `
import { decisionGate } from "cloving/workflows/steps/decision-gate";
import { prompt } from "./develop/prompts.ts";
export async function localDevelop(input, continuation) {
  "use workflow";
  if (continuation !== undefined) return prompt();
  await decisionGate({ gateId: "bundle-question", kind: "question", prompt: "Continue this bundle?" });
  return { kind: "waiting_for_decision" };
}`;

const prelude = `${queuePrelude}${workflowBundleLoader()}
const snapshot = JSON.parse(readFileSync(process.env.SNAPSHOT, "utf8"));
const generation = await loadWorkflowBundle(directory + "/workflow-bundles/" + snapshot.bundleDigest);
const daemon = await launched({ ...snapshot, workflows: generation.workflows, handler: generation.handler, loadBundle: loadWorkflowBundle, queueMilliseconds: undefined });
`;

const waitingScript = `${prelude.replace("process.env.SNAPSHOT", '"old.json"')}
const admitted = await submitted("earlier", { workflowId: "local-helper", source: "input", submission: {} });
assert.equal(admitted.kind, "run-admitted", JSON.stringify(admitted));
writeFileSync("waiting-run", admitted.runId);
await until(async () => (await shown(admitted.runId)).state === "waiting_gate");
await until(async () => (await (await getWorld()).runs.list({})).data.every(run => run.status === "completed"));
await halt("waiting-helper");
`;

const resumeScript = `${prelude.replace("process.env.SNAPSHOT", '"current.json"')}
try {
  const finish = async (runId, commandId) => {
    const answer = await asked("decision", { command: "answer", reference: runId + "/bundle-question", text: "Continue.", subjectDigest: (await import(${JSON.stringify(new URL("./service-fixture.ts", import.meta.url).href)})).digestOf("Continue this bundle?"), expectedRevision: 1, generation: 1, commandId });
    assert.equal(answer.kind, "decision-recorded", JSON.stringify(answer));
    await until(async () => (await shown(runId)).state === "completed");
  };
  await finish(readFileSync("waiting-run", "utf8"), "answer-earlier");
  const admitted = await submitted("current", { workflowId: "local-helper", source: "input", submission: {} });
  await until(async () => (await shown(admitted.runId)).state === "waiting_gate");
  await finish(admitted.runId, "answer-current");
  await until(async () => (await (await getWorld()).runs.list({})).data.every(run => run.status === "completed"));
  const values = await Promise.all((await (await getWorld()).runs.list({})).data.map(run => getRun(run.runId).returnValue));
  assert.deepEqual(values.map(value => value.helper).filter(Boolean).sort(), ["current", "earlier"]);
} finally { await daemon.close(); }
`;

async function prepareWorkflow(directory: string) {
  const settings = {
    product: candidatePackageRoot,
    project: join(directory, "project"),
    repository: directory,
    home: directory,
    xdgConfigHome: join(directory, "config"),
  };
  const folder = join(directory, ".cloving/workflows");
  await mkdir(join(folder, "develop"), { recursive: true });
  await writeFile(join(folder, "local.ts"), workflow);
  await writeFile(join(folder, "local.test.ts"), "test file ignored");
  await writeFile(
    join(folder, "local.declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: "local-helper",
      },
    }),
  );
  const helper = join(folder, "develop/prompts.ts");
  const earlier =
    'import { marker } from "./marker.ts";\nexport function prompt() { return { kind: "completed", helper: "earlier", marker }; }';
  await writeFile(helper, earlier);
  await writeFile(
    join(folder, "develop/marker.ts"),
    'export const marker = "captured-marker";',
  );
  return { settings, helper, earlier };
}

await test("CLV-216 a waiting run resumes its earlier helper after source change and process restart", () =>
  withConsumer(
    'export async function develop() {\n  "use workflow";\n  return 1;\n}',
    async (consumer) => {
      const { settings, helper, earlier } = await prepareWorkflow(
        consumer.directory,
      );
      const original = await preparedProject(settings);
      assert.deepEqual(original["workflowRefusals"], []);
      await writeFile(
        join(consumer.directory, "old.json"),
        JSON.stringify(original),
      );
      const first = await consumer.runUntil("waiting-helper", waitingScript);
      assert.equal(first.status, null, first.stderr);
      await writeFile(helper, earlier.replace("earlier", "current"));
      const current = await preparedProject(settings);
      assert.deepEqual(current["workflowRefusals"], []);
      assert.notEqual(current["bundleDigest"], original["bundleDigest"]);
      await writeFile(
        join(consumer.directory, "current.json"),
        JSON.stringify(current),
      );
      const retained = join(
        consumer.directory,
        "workflow-bundles",
        original["bundleDigest"],
        "workflows/operators",
      );
      const [name] = await readdir(retained);
      assert.ok(name);
      assert.equal(
        await readFile(join(retained, name, "develop/prompts.ts"), "utf8"),
        earlier,
      );
      const resumed = await consumer.run(resumeScript);
      assert.equal(resumed.status, 0, resumed.stderr);
    },
  ));
