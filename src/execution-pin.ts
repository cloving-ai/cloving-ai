import type {
  AdmissionResult,
  ExecutionManifest,
} from "./workflow-admission.ts";
import { isWorkflowNames } from "./workflow-declaration.ts";

const canonical: Readonly<
  Record<keyof ExecutionManifest, (manifest: ExecutionManifest) => string>
> = {
  queue: (manifest) => JSON.stringify(manifest.queue === true),
  name: (manifest) => JSON.stringify(manifest.name),
  workflowId: (manifest) => JSON.stringify(manifest.workflowId),
  steps: (manifest) => JSON.stringify([...manifest.steps].sort()),
  capabilities: (manifest) => JSON.stringify([...manifest.capabilities].sort()),
  handoffs: (manifest) => JSON.stringify([...(manifest.handoffs ?? [])].sort()),
  commands: (manifest) => JSON.stringify([...(manifest.commands ?? [])].sort()),
  bundleDigest: (manifest) => JSON.stringify(manifest.bundleDigest),
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

export function executionCapabilities(manifest: ExecutionManifest): string {
  const handoff = manifest.handoffs?.length ? ["handoff"] : [];
  return JSON.stringify(
    [...new Set([...manifest.capabilities, ...handoff])].sort(),
  );
}

export function pinnedIdentity(manifest: ExecutionManifest): string {
  const identity = fields.map((field) => canonical[field](manifest));
  if (manifest.handoffs?.length) identity.push(canonical.handoffs(manifest));
  if (manifest.commands?.length)
    identity.push(JSON.stringify(["commands", canonical.commands(manifest)]));
  if (manifest.bundleDigest !== undefined)
    identity.push(canonical.bundleDigest(manifest));
  if (manifest.queue === true) identity.push(JSON.stringify(["queue", true]));
  return JSON.stringify(identity);
}

export function resumePinned(
  pinned: ExecutionManifest,
  available: ExecutionManifest,
): AdmissionResult {
  const changed = (
    [...fields, "handoffs", "commands", "bundleDigest", "queue"] as const
  ).find((field) => canonical[field](pinned) !== canonical[field](available));
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
  const commands = fields["commands"];
  if (Object.hasOwn(fields, "handoffs") && !isWorkflowNames(handoffs))
    throw new Error("invalid-handoffs");
  if (Object.hasOwn(fields, "commands") && !isWorkflowNames(commands))
    throw new Error("invalid-commands");
  return {
    name: text(fields["name"]),
    workflowId: text(fields["workflowId"]),
    steps: texts(fields["steps"]),
    capabilities: texts(fields["capabilities"]),
    ...queueMetadata(fields),
    ...(isWorkflowNames(handoffs) ? { handoffs: [...handoffs] } : {}),
    ...(isWorkflowNames(commands) ? { commands: [...commands] } : {}),
    ...(Object.hasOwn(fields, "bundleDigest")
      ? { bundleDigest: text(fields["bundleDigest"]) }
      : {}),
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
  declaration: {
    readonly handoffs?: readonly string[];
    readonly commands?: readonly string[];
    readonly bundleDigest?: string | undefined;
    readonly queue?: boolean;
  },
): ExecutionManifest {
  return readExecutionManifest({
    ...manifest,
    ...(declaration.queue === undefined ? {} : { queue: declaration.queue }),
    ...(declaration.commands === undefined
      ? {}
      : { commands: declaration.commands }),
    ...(declaration.handoffs === undefined
      ? {}
      : { handoffs: declaration.handoffs }),
    ...(declaration.bundleDigest === undefined
      ? {}
      : { bundleDigest: declaration.bundleDigest }),
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

function queueMetadata(
  fields: Readonly<Record<string, unknown>>,
): Pick<ExecutionManifest, "queue"> {
  if (Object.hasOwn(fields, "queue") && typeof fields["queue"] !== "boolean")
    throw new Error("invalid-queue");
  return fields["queue"] === true ? { queue: true } : {};
}
