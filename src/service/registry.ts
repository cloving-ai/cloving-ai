import type { WorkflowStage, WorkflowStages } from "../workflow-declaration.ts";
import { workflowPin } from "../broker/workflow-pin.ts";
import { declaredManifest } from "../execution-pin.ts";
import type { SubmissionContract } from "../submission.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";

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
}

export interface Resolver {
  readonly id: string;
  readonly version: string;
  readonly resolve: (request: ResolutionRequest) => Promise<Resolution>;
}

export interface WorkflowRegistration {
  readonly workflowId: string;
  readonly manifest: ExecutionManifest;
  readonly availability: "available" | "unavailable";
  readonly submission: SubmissionContract;
  readonly resolver: Resolver;
  readonly effectLimit?: number;
  readonly stages?: readonly WorkflowStage[];
  readonly handoffs?: readonly string[];
  readonly admission?: "when-idle";
}

export interface Registered extends WorkflowRegistration {
  readonly pin: string;
}

export interface Registry {
  readonly workflowIds: readonly string[];
  readonly workflowStages: WorkflowStages;
  readonly byId: (workflowId: string) => Registered | undefined;
  readonly byPin: (pin: string) => Registered | undefined;
  readonly available: (
    pinned: ExecutionManifest,
  ) => ExecutionManifest | undefined;
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

export function workflowRegistry(
  workflows: readonly WorkflowRegistration[],
  retainedWorkflows: readonly WorkflowRegistration[] = [],
): Registry {
  const current = workflows.map(registered);
  const available = [...current, ...retainedWorkflows.map(registered)].filter(
    (workflow) => workflow.availability === "available",
  );
  const byPin = (pin: string): Registered | undefined =>
    available.find((workflow) => workflow.pin === pin);
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
    available: (pinned) => byPin(workflowPin(pinned))?.manifest,
  };
}
