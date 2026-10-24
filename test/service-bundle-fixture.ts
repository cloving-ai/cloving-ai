import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import { call, field, type Harness } from "./service-fixture.ts";

export async function bundled(harness: Harness) {
  const project = harness.projectDirectory;
  const files = {
    "package.json": '{"type":"module"}',
    "declarations.json": "[]",
    "dependencies.json": "{}",
    "workflows/develop.ts": "workflow source",
    "artifacts/client.mjs": "compiled client",
    "artifacts/flow.mjs": "compiled flow",
    "artifacts/steps.mjs": "compiled steps",
    "artifacts/manifest.json": "{}",
    "artifacts/flow.mjs.__wf_tmp.js.debug.json": "{}",
    "artifacts/steps.mjs.debug.json": "{}",
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(project, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const workflowBundles = {
    directory: join(harness.stateDirectory, "bundles"),
    repository: project,
  };
  const bundleDigest = await retainWorkflowBundle({
    ...workflowBundles,
    project,
  });
  return {
    workflowBundles,
    bundleDigest,
    workflows: [
      {
        ...harness.registration,
        manifest: { ...harness.registration.manifest, bundleDigest },
      },
    ],
  };
}

export async function reason(harness: Harness, runId: string) {
  const status = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  return field(field(field(status, "run"), "reason"), "code");
}
