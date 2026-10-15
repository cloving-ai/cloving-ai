import { workflowPin } from "../broker/workflow-pin.ts";
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
  readonly admission?: "when-idle";
}

export interface Registered extends WorkflowRegistration {
  readonly pin: string;
}

export interface Registry {
  readonly workflowIds: readonly string[];
  readonly byId: (workflowId: string) => Registered | undefined;
  readonly byPin: (pin: string) => Registered | undefined;
  readonly available: (
    pinned: ExecutionManifest,
  ) => ExecutionManifest | undefined;
}

export function workflowRegistry(
  workflows: readonly WorkflowRegistration[],
): Registry {
  const registered = workflows.map((workflow) => ({
    ...workflow,
    pin: workflowPin(workflow.manifest),
  }));
  return {
    workflowIds: registered.map((workflow) => workflow.workflowId),
    byId: (workflowId) =>
      registered.find((workflow) => workflow.workflowId === workflowId),
    byPin: (pin) => registered.find((workflow) => workflow.pin === pin),
    available: (pinned) =>
      registered.find(
        (workflow) => workflow.manifest.workflowId === pinned.workflowId,
      )?.manifest,
  };
}
