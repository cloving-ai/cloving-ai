import type {
  AdmissionResult,
  ExecutionManifest,
} from "./workflow-admission.ts";

const canonical: Readonly<
  Record<keyof ExecutionManifest, (manifest: ExecutionManifest) => string>
> = {
  name: (manifest) => JSON.stringify(manifest.name),
  workflowId: (manifest) => JSON.stringify(manifest.workflowId),
  steps: (manifest) => JSON.stringify([...manifest.steps].sort()),
  capabilities: (manifest) => JSON.stringify([...manifest.capabilities].sort()),
  artifacts: (manifest) =>
    JSON.stringify(
      Object.keys(manifest.artifacts)
        .sort()
        .map((name) => [name, manifest.artifacts[name]]),
    ),
  resources: (manifest) =>
    JSON.stringify(
      Object.keys(manifest.resources)
        .sort()
        .map((name) => [name, manifest.resources[name]]),
    ),
  toolchain: (manifest) =>
    JSON.stringify(
      (["sdk", "world", "builder", "node", "dependencies"] as const).map(
        (key) => manifest.toolchain[key],
      ),
    ),
};

const fields = [
  "name",
  "workflowId",
  "steps",
  "capabilities",
  "artifacts",
  "resources",
  "toolchain",
] as const;

export function pinnedIdentity(manifest: ExecutionManifest): string {
  return JSON.stringify(fields.map((field) => canonical[field](manifest)));
}

export function resumePinned(
  pinned: ExecutionManifest,
  available: ExecutionManifest,
): AdmissionResult {
  const changed = fields.find(
    (field) => canonical[field](pinned) !== canonical[field](available),
  );
  if (changed !== undefined)
    return {
      kind: "rejected",
      reason: "pinned-manifest-mismatch",
      detail: changed,
    };
  return { kind: "admitted", manifest: pinned };
}
