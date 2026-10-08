export interface WorkflowArtifactContract {
  readonly workflows: readonly string[];
  readonly steps: readonly string[];
}

export async function inspectWorkflowArtifacts(
  directory: string,
  regenerated: string,
  contract: WorkflowArtifactContract,
): Promise<Readonly<Record<string, string>>> {
  if ((await realpath(directory)) === (await realpath(regenerated)))
    throw new Error("workflow-regeneration-not-independent");
  if (contract.workflows.length === 0)
    throw new Error("empty-workflow-contract");
  const actual = await artifactDigests(directory);
  const expected = await artifactDigests(regenerated);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("workflow-artifact-mismatch");
  const manifest: unknown = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  checkRegistrations(manifest, "workflows", "workflowId", contract.workflows);
  checkRegistrations(manifest, "steps", "stepId", contract.steps);
  return actual;
}

async function artifactDigests(
  directory: string,
): Promise<Record<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const required = [
    "client.mjs",
    "flow.mjs",
    "flow.mjs.__wf_tmp.js.debug.json",
    "manifest.json",
    "steps.mjs",
    "steps.mjs.debug.json",
  ];
  if (
    entries.some((entry) => !entry.isFile()) ||
    JSON.stringify(names) !== JSON.stringify(required)
  )
    throw new Error("workflow-artifact-inventory");
  const result: Record<string, string> = {};
  for (const name of names)
    result[name] = createHash("sha256")
      .update(await readFile(join(directory, name)))
      .digest("hex");
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function checkRegistrations(
  manifest: unknown,
  category: string,
  identifier: string,
  required: readonly string[],
): void {
  if (!record(manifest) || !record(manifest[category]))
    throw new Error("invalid-workflow-manifest");
  const identifiers: string[] = [];
  for (const entries of Object.values(manifest[category])) {
    if (!record(entries)) throw new Error("invalid-workflow-manifest");
    for (const entry of Object.values(entries)) {
      if (!record(entry) || typeof entry[identifier] !== "string")
        throw new Error("invalid-workflow-manifest");
      identifiers.push(entry[identifier]);
    }
  }
  for (const expected of required) {
    if (!identifiers.includes(expected))
      throw new Error(
        `missing-${identifier.replace("Id", "")}-registration: ${expected}`,
      );
  }
}
import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
