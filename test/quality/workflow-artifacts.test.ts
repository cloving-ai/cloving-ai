import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { join } from "node:path";
import { inspectWorkflowArtifacts } from "../../quality/workflow-artifacts.ts";
import { withFiles } from "./files-fixture.ts";

const contract = {
  workflows: ["workflow//./workflows/main//main"],
  steps: ["step//cloving/workflows@0.4.0//recordEffect"],
};
const artifacts = {
  "client.mjs": "export const client = {};",
  "flow.mjs": "export const workflow = {};",
  "steps.mjs": "export const step = {};",
  "flow.mjs.__wf_tmp.js.debug.json": "{}",
  "steps.mjs.debug.json": "{}",
  "manifest.json": JSON.stringify({
    workflows: {
      "workflows/main.ts": { main: { workflowId: contract.workflows[0] } },
    },
    steps: {
      "node_modules/cloving/workflows.js": {
        recordEffect: { stepId: contract.steps[0] },
      },
    },
    classes: {},
  }),
};

async function inspect(
  candidate: Readonly<Record<string, string>>,
  expected = contract,
): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = Object.fromEntries([
    ...Object.entries(candidate).map(([name, content]): [string, string] => [
      `candidate/${name}`,
      content,
    ]),
    ...Object.entries(artifacts).map(([name, content]): [string, string] => [
      `regenerated/${name}`,
      content,
    ]),
  ]);
  return withFiles(files, (directory) =>
    inspectWorkflowArtifacts(
      join(directory, "candidate"),
      join(directory, "regenerated"),
      expected,
    ),
  );
}

await test("QG-07 binds every SDK handler, registration and debug artifact to regeneration", async () => {
  const record = await inspect(artifacts);
  assert.deepEqual(Object.keys(record).sort(), Object.keys(artifacts).sort());
  assert.equal(
    record["steps.mjs"],
    createHash("sha256").update(artifacts["steps.mjs"]).digest("hex"),
  );
});

await test("QG-07 rejects missing SDK handlers and changed or additional generated payloads", async () => {
  const missing = { ...artifacts };
  Reflect.deleteProperty(missing, "flow.mjs");
  await assert.rejects(inspect(missing), /workflow-artifact-inventory/);
  await assert.rejects(
    inspect({ ...artifacts, "steps.mjs": "export {};" }),
    /workflow-artifact-mismatch/,
  );
  await assert.rejects(
    inspect({ ...artifacts, "hidden.js": "export {};" }),
    /workflow-artifact-inventory/,
  );
});

await test("QG-07 rejects a packed helper or workflow missing from the SDK registration", async () => {
  await assert.rejects(
    inspect(artifacts, { ...contract, steps: ["step//missing//helper"] }),
    /missing-step-registration/,
  );
  await assert.rejects(
    inspect(artifacts, { ...contract, workflows: ["workflow//missing//main"] }),
    /missing-workflow-registration/,
  );
  await assert.rejects(
    inspect(artifacts, { ...contract, workflows: [] }),
    /empty-workflow-contract/,
  );
});

await test("QG-07 rejects comparing a generated directory to an alias of itself", async () => {
  await withFiles(artifacts, async (directory) => {
    await assert.rejects(
      inspectWorkflowArtifacts(directory, `${directory}/.`, contract),
      /workflow-regeneration-not-independent/,
    );
  });
});
