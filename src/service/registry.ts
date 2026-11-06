import type {
  CommandWaits,
  WorkflowStage,
  WorkflowStages,
} from "../workflow-declaration.ts";
import { workflowPin } from "../broker/workflow-pin.ts";
import { declaredManifest } from "../execution-pin.ts";
import type { SubmissionContract } from "../submission.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";
import type { AvailableManifest } from "../broker/actor/delivery-intents.ts";
import { readRetainedWorkflowBundle } from "../../tools/workflow-bundles.ts";
import {
  workflowRefusals,
  type WorkflowRefusal,
} from "../workflow-refusals.ts";

export interface WorkflowBundleStore {
  readonly directory: string;
  readonly repository: string;
}

export type Resolution =
  | { readonly kind: "resolved"; readonly input: unknown }
  | {
      readonly kind: "rejected";
      readonly code: string;
      readonly detail: string;
    };

export interface ResolutionRequest {
  readonly workflowId: string;
  readonly submission: Readonly<Record<string, unknown>>;
  readonly commandId: string;
  readonly signal: AbortSignal;
  readonly activeTickets?: readonly Readonly<Record<string, unknown>>[];
}

export interface Resolver {
  readonly id: string;
  readonly version: string;
  readonly resolve: (request: ResolutionRequest) => Promise<Resolution>;
  readonly skippedTickets?: () => readonly Readonly<Record<string, unknown>>[];
}

export interface WorkflowRegistration {
  readonly queue?: boolean;
  readonly workflowId: string;
  readonly manifest: ExecutionManifest;
  readonly availability: "available" | "unavailable";
  readonly submission: SubmissionContract;
  readonly resolver: Resolver;
  readonly effectLimit?: number;
  readonly chainLimit?: number;
  readonly spendLimitUsd?: number;
  readonly stages?: readonly WorkflowStage[];
  readonly handoffs?: readonly string[];
  readonly commands?: readonly string[];
  readonly commandWaits?: CommandWaits;
  readonly admission?: "when-idle" | number;
}

export interface Registered extends WorkflowRegistration {
  readonly pin: string;
}

export interface Registry {
  readonly workflowIds: readonly string[];
  readonly workflowStages: WorkflowStages;
  readonly byId: (workflowId: string) => Registered | undefined;
  readonly byPin: (pin: string) => Registered | undefined;
  readonly bundle: (pinned: ExecutionManifest) => Promise<string | undefined>;
  readonly available: AvailableManifest;
}

function registered(workflow: WorkflowRegistration): Registered {
  const manifest = declaredManifest(workflow.manifest, workflow);
  return {
    ...workflow,
    ...(manifest.handoffs === undefined ? {} : { handoffs: manifest.handoffs }),
    manifest,
    pin: workflowPin(manifest),
  };
}

function availableVersions(workflow: Registered): readonly Registered[] {
  if (workflow.availability !== "available") return [];
  if (workflow.manifest.bundleDigest === undefined) return [workflow];
  const manifest = { ...workflow.manifest };
  delete manifest.bundleDigest;
  return [workflow, { ...workflow, manifest, pin: workflowPin(manifest) }];
}

export interface RegistryOptions {
  readonly retainedWorkflows?: readonly WorkflowRegistration[];
  readonly workflowBundles?: WorkflowBundleStore;
  readonly retainedWorkflow?: AvailableManifest;
}

export interface ReplaceableRegistry extends Registry {
  readonly replace: (workflows: readonly WorkflowRegistration[]) => void;
}

export function replaceableRegistry(
  workflows: readonly WorkflowRegistration[],
  options: RegistryOptions = {},
): ReplaceableRegistry {
  let earlier = [...workflows, ...(options.retainedWorkflows ?? [])];
  let current = workflowRegistry(workflows, options);
  return {
    get workflowIds() {
      return current.workflowIds;
    },
    get workflowStages() {
      return current.workflowStages;
    },
    byId: (workflowId) => current.byId(workflowId),
    byPin: (pin) => current.byPin(pin),
    bundle: (pinned) => current.bundle(pinned),
    available: (pinned) => current.available(pinned),
    replace: (next) => {
      const replacement = workflowRegistry(next, {
        ...options,
        retainedWorkflows: earlier,
      });
      earlier = [...next, ...earlier];
      current = replacement;
    },
  };
}

export function workflowRegistry(
  workflows: readonly WorkflowRegistration[],
  options: RegistryOptions = {},
): Registry {
  const current = workflows.map(registered);
  const available = [
    ...current,
    ...(options.retainedWorkflows ?? []).map(registered),
  ].flatMap(availableVersions);
  const byPin = (pin: string): Registered | undefined =>
    available.find((workflow) => workflow.pin === pin);
  const bundle = async (pinned: ExecutionManifest) => {
    if (
      pinned.bundleDigest === undefined ||
      options.workflowBundles === undefined
    )
      return undefined;
    const retained = await readRetainedWorkflowBundle({
      ...options.workflowBundles,
      id: pinned.bundleDigest,
    });
    return retained.kind === "available" ? retained.directory : undefined;
  };
  return {
    workflowIds: current.map((workflow) => workflow.workflowId),
    workflowStages: Object.fromEntries(
      current.flatMap((workflow) =>
        workflow.stages === undefined
          ? []
          : [[workflow.workflowId, workflow.stages]],
      ),
    ),
    byId: (workflowId) =>
      current.find((workflow) => workflow.workflowId === workflowId),
    byPin,
    bundle,
    available: (pinned) => {
      const manifest = byPin(workflowPin(pinned))?.manifest;
      if (pinned.bundleDigest === undefined) return manifest;
      return bundle(pinned).then((directory) =>
        directory !== undefined
          ? (manifest ?? options.retainedWorkflow?.(pinned))
          : undefined,
      );
    },
  };
}

interface WorkflowInventory {
  readonly bundleDigest?: string;
  readonly workflowRefusals: readonly WorkflowRefusal[];
}

export interface WorkflowCatalog {
  readonly registry: Registry;
  readonly inventory: () => WorkflowInventory;
  readonly replace: (next: {
    readonly bundleDigest: string;
    readonly workflows: readonly WorkflowRegistration[];
    readonly workflowRefusals: readonly WorkflowRefusal[];
  }) => void;
  readonly replaceRefusals: (refusals: readonly WorkflowRefusal[]) => void;
}

export function workflowCatalog(
  options: RegistryOptions & {
    readonly workflows: readonly WorkflowRegistration[];
    readonly bundleDigest?: string;
    readonly workflowRefusals?: readonly WorkflowRefusal[];
  },
): WorkflowCatalog {
  const registry = replaceableRegistry(options.workflows, options);
  let inventory: WorkflowInventory = {
    ...(options.bundleDigest === undefined
      ? {}
      : { bundleDigest: options.bundleDigest }),
    workflowRefusals: workflowRefusals(options.workflowRefusals),
  };
  return {
    registry,
    inventory: () => inventory,
    replace: (next) => {
      registry.replace(next.workflows);
      inventory = {
        bundleDigest: next.bundleDigest,
        workflowRefusals: next.workflowRefusals,
      };
    },
    replaceRefusals: (refusals) => {
      inventory = { ...inventory, workflowRefusals: refusals };
    },
  };
}
