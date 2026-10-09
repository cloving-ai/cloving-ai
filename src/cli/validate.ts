import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pinnedIdentity } from "../execution-pin.ts";
import { collectResources } from "../resource-files.ts";
import { admitWorkflow } from "../workflow-admission.ts";
import { validateDevelopmentInput } from "../workflow-contracts.ts";
import { observedToolchain, qualifiedToolchain } from "./toolchain.ts";

const artifactNames = [
  "client.mjs",
  "flow.mjs",
  "flow.mjs.__wf_tmp.js.debug.json",
  "manifest.json",
  "steps.mjs",
  "steps.mjs.debug.json",
];

export interface ValidationError {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}

export type ValidationReport =
  | {
      readonly schemaVersion: 1;
      readonly kind: "workflow-validation";
      readonly status: "valid";
      readonly workflow: { readonly name: string; readonly workflowId: string };
      readonly pinnedIdentity: string;
      readonly errors: readonly ValidationError[];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "workflow-validation";
      readonly status: "rejected";
      readonly errors: readonly ValidationError[];
    };

type Admission =
  | {
      readonly kind: "admitted";
      readonly workflow: { readonly name: string; readonly workflowId: string };
      readonly pinnedIdentity: string;
    }
  | { readonly kind: "rejected"; readonly error: ValidationError };

export async function validateWorkflow(
  directory: string,
  manifest: string,
  input: string | null,
): Promise<ValidationReport> {
  const errors =
    input === null ? [] : await inputErrors(resolve(directory, input), input);
  const admission = await admit(resolve(directory, manifest), manifest);
  if (admission.kind === "rejected") errors.push(admission.error);
  if (admission.kind === "rejected" || errors.length > 0)
    return {
      schemaVersion: 1,
      kind: "workflow-validation",
      status: "rejected",
      errors,
    };
  return {
    schemaVersion: 1,
    kind: "workflow-validation",
    status: "valid",
    workflow: admission.workflow,
    pinnedIdentity: admission.pinnedIdentity,
    errors: [],
  };
}

async function inputErrors(
  path: string,
  file: string,
): Promise<ValidationError[]> {
  const value = await readJson(path);
  if (value === null)
    return [{ code: "unreadable-input", file, detail: "json" }];
  if (validateDevelopmentInput(value).kind === "valid") return [];
  return [{ code: "invalid-development-input", file, detail: "cycleId" }];
}

async function admit(path: string, file: string): Promise<Admission> {
  const registration = fields(await readJson(path));
  const artifacts = registration["artifacts"];
  if (registration["schemaVersion"] !== 1 || typeof artifacts !== "string")
    return rejected("invalid-manifest", file, "schemaVersion or artifacts");
  const root = dirname(path);
  const directory = resolve(root, artifacts);
  const digests: Record<string, string> = {};
  const contents: Record<string, Buffer> = {};
  for (const name of artifactNames) {
    const bytes = await readFile(resolve(directory, name)).catch(() => null);
    if (bytes === null) return rejected("missing-artifact", file, name);
    digests[name] = createHash("sha256").update(bytes).digest("hex");
    contents[name] = bytes;
  }
  const declared = registration["resources"];
  const toolchain = await observedToolchain(directory);
  const result = admitWorkflow(
    registration,
    {
      manifest: parseJson(contents["manifest.json"]?.toString("utf8") ?? ""),
      artifacts: digests,
      resources: await collectResources(
        root,
        Array.isArray(declared)
          ? declared.filter((item) => typeof item === "string")
          : [],
      ),
      toolchain,
    },
    {
      toolchain: await qualifiedToolchain(toolchain, directory),
      capabilities: [],
    },
  );
  if (result.kind === "rejected")
    return rejected(result.reason, file, result.detail);
  return {
    kind: "admitted",
    workflow: {
      name: result.manifest.name,
      workflowId: result.manifest.workflowId,
    },
    pinnedIdentity: createHash("sha256")
      .update(pinnedIdentity(result.manifest))
      .digest("hex"),
  };
}

function rejected(code: string, file: string, detail: string): Admission {
  return { kind: "rejected", error: { code, file, detail } };
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch(() => null);
  return text === null ? null : parseJson(text);
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}
