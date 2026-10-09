import { resolveResources } from "./workflow-resources.ts";

const versionedStep = /^step\/\/(?!\.\/)(?:@[^/@]+\/)?[^@]+@[^/@]+\/\/.+$/;

export interface ToolchainIdentity {
  readonly sdk: string;
  readonly world: string;
  readonly builder: string;
  readonly node: string;
  readonly dependencies: string;
}

export interface WorkflowRegistration {
  readonly name: string;
  readonly workflowId: string;
  readonly steps: readonly string[];
  readonly capabilities: readonly string[];
  readonly resources: readonly string[];
}

export interface CompiledWorkflow {
  readonly manifest: unknown;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, string>>;
  readonly toolchain: ToolchainIdentity;
}

export interface AdmissionPolicy {
  readonly toolchain: ToolchainIdentity;
  readonly capabilities: readonly string[];
}

export interface ExecutionManifest {
  readonly name: string;
  readonly workflowId: string;
  readonly steps: readonly string[];
  readonly capabilities: readonly string[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, string>>;
  readonly toolchain: ToolchainIdentity;
}

export type AdmissionResult =
  | { readonly kind: "admitted"; readonly manifest: ExecutionManifest }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly detail: string;
    };

export function admitWorkflow(
  proposedRegistration: unknown,
  proposedCompiled: unknown,
  policy: AdmissionPolicy,
): AdmissionResult {
  const registration = readRegistration(proposedRegistration);
  if (!registration) return rejected("invalid-registration", "registration");
  const compiled = record(proposedCompiled) ?? {};
  const toolchain = readToolchain(compiled["toolchain"]);
  const rejection =
    registrationRejection(registration, policy) ??
    toolchainRejection(toolchain, policy.toolchain) ??
    manifestRejection(registration, compiled["manifest"]);
  if (rejection) return rejection;
  const artifacts = readArtifacts(compiled["artifacts"]);
  if (!artifacts) return rejected("invalid-artifacts", "artifacts");
  const resources = resolveResources(
    registration.resources,
    compiled["resources"],
  );
  if (resources.kind === "inaccessible")
    return rejected("inaccessible-resource", resources.path);
  return {
    kind: "admitted",
    manifest: Object.freeze({
      name: registration.name,
      workflowId: registration.workflowId,
      steps: Object.freeze([...registration.steps]),
      capabilities: Object.freeze([...registration.capabilities]),
      artifacts: Object.freeze(artifacts),
      resources: Object.freeze(resources.resources),
      toolchain: Object.freeze(toolchain),
    }),
  };
}

function readRegistration(value: unknown): WorkflowRegistration | null {
  const fields = record(value);
  if (!fields) return null;
  const { name, workflowId, steps, capabilities, resources } = fields;
  if (
    typeof name !== "string" ||
    typeof workflowId !== "string" ||
    !textList(steps) ||
    !textList(capabilities) ||
    !textList(resources)
  )
    return null;
  return { name, workflowId, steps, capabilities, resources };
}

function readToolchain(value: unknown): ToolchainIdentity {
  const fields = record(value) ?? {};
  const textField = (key: keyof ToolchainIdentity): string => {
    const field = fields[key];
    return typeof field === "string" ? field : "";
  };
  return {
    sdk: textField("sdk"),
    world: textField("world"),
    builder: textField("builder"),
    node: textField("node"),
    dependencies: textField("dependencies"),
  };
}

function readArtifacts(value: unknown): Record<string, string> | null {
  const entries: Array<[string, string]> = [];
  for (const [name, digest] of Object.entries(record(value) ?? {})) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
      return null;
    entries.push([name, digest]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function textList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function registrationRejection(
  registration: WorkflowRegistration,
  policy: AdmissionPolicy,
): AdmissionResult | null {
  if (
    !text(registration.name) ||
    !text(registration.workflowId) ||
    !distinctTexts(registration.steps) ||
    !distinctTexts(registration.capabilities) ||
    !distinctTexts(registration.resources)
  )
    return rejected("invalid-registration", "registration");
  const unversioned = registration.steps.find(
    (step) => !versionedStep.test(step),
  );
  if (unversioned !== undefined)
    return rejected("unversioned-step", unversioned);
  const unsupported = registration.capabilities.find(
    (capability) => !policy.capabilities.includes(capability),
  );
  if (unsupported !== undefined)
    return rejected("unsupported-capability", unsupported);
  return null;
}

function toolchainRejection(
  compiled: ToolchainIdentity,
  accepted: ToolchainIdentity,
): AdmissionResult | null {
  const keys = ["sdk", "world", "builder", "node", "dependencies"] as const;
  const changed = keys.find((key) => compiled[key] !== accepted[key]);
  if (changed !== undefined) return rejected("incompatible-toolchain", changed);
  return null;
}

function manifestRejection(
  registration: WorkflowRegistration,
  manifest: unknown,
): AdmissionResult | null {
  const registry = readRegistry(manifest);
  if (!registry) return rejected("invalid-manifest", "manifest");
  const identifiers = [...registry.workflows, ...registry.steps];
  const duplicate = identifiers.find(
    (identifier, index) => identifiers.indexOf(identifier) !== index,
  );
  if (duplicate !== undefined)
    return rejected("duplicate-registration", duplicate);
  if (!registry.workflows.includes(registration.workflowId))
    return rejected("unresolved-workflow", registration.workflowId);
  const missing = registration.steps.find(
    (step) => !registry.steps.includes(step),
  );
  if (missing !== undefined) return rejected("unresolved-step", missing);
  return null;
}

function text(value: string): boolean {
  return value.trim().length > 0;
}

function distinctTexts(values: readonly string[]): boolean {
  return values.every(text) && new Set(values).size === values.length;
}

function rejected(reason: string, detail: string): AdmissionResult {
  return { kind: "rejected", reason, detail };
}

function readRegistry(
  manifest: unknown,
): { readonly workflows: string[]; readonly steps: string[] } | null {
  const categories = record(manifest);
  if (!categories) return null;
  const workflows = identifiers(categories["workflows"], "workflowId");
  const steps = identifiers(categories["steps"], "stepId");
  if (!workflows || !steps) return null;
  return { workflows, steps };
}

function identifiers(category: unknown, key: string): string[] | null {
  const files = record(category);
  if (!files) return null;
  const found: string[] = [];
  for (const entries of Object.values(files)) {
    const named = record(entries);
    if (!named) return null;
    for (const entry of Object.values(named)) {
      const identifier = record(entry)?.[key];
      if (typeof identifier !== "string") return null;
      found.push(identifier);
    }
  }
  return found;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}
