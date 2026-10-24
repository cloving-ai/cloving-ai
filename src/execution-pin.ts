import type {
  AdmissionResult,
  ExecutionManifest,
} from "./workflow-admission.ts";
import { isWorkflowHandoffs } from "./workflow-declaration.ts";

const canonical: Readonly<
  Record<keyof ExecutionManifest, (manifest: ExecutionManifest) => string>
> = {
  name: (manifest) => JSON.stringify(manifest.name),
  workflowId: (manifest) => JSON.stringify(manifest.workflowId),
  steps: (manifest) => JSON.stringify([...manifest.steps].sort()),
  capabilities: (manifest) => JSON.stringify([...manifest.capabilities].sort()),
  handoffs: (manifest) => JSON.stringify([...(manifest.handoffs ?? [])].sort()),
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
  const identity = fields.map((field) => canonical[field](manifest));
  if (manifest.handoffs?.length) identity.push(canonical.handoffs(manifest));
  return JSON.stringify(identity);
}

export function resumePinned(
  pinned: ExecutionManifest,
  available: ExecutionManifest,
): AdmissionResult {
  const changed = ([...fields, "handoffs"] as const).find(
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

export function readExecutionManifest(value: unknown): ExecutionManifest {
  const fields = record(value);
  const toolchain = record(fields["toolchain"]);
  const handoffs = fields["handoffs"];
  if (Object.hasOwn(fields, "handoffs") && !isWorkflowHandoffs(handoffs))
    throw new Error("invalid-handoffs");
  return {
    name: text(fields["name"]),
    workflowId: text(fields["workflowId"]),
    steps: texts(fields["steps"]),
    capabilities: texts(fields["capabilities"]),
    ...(isWorkflowHandoffs(handoffs) ? { handoffs: [...handoffs] } : {}),
    artifacts: textRecord(fields["artifacts"]),
    resources: textRecord(fields["resources"]),
    toolchain: {
      sdk: text(toolchain["sdk"]),
      world: text(toolchain["world"]),
      builder: text(toolchain["builder"]),
      node: text(toolchain["node"]),
      dependencies: text(toolchain["dependencies"]),
    },
  };
}

export function declaredManifest(
  manifest: ExecutionManifest,
  declaration: { readonly handoffs?: readonly string[] },
): ExecutionManifest {
  return readExecutionManifest({
    ...manifest,
    ...(declaration.handoffs === undefined
      ? {}
      : { handoffs: declaration.handoffs }),
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function texts(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(text) : [];
}

function textRecord(value: unknown): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, item]) => [key, text(item)]),
  );
}
