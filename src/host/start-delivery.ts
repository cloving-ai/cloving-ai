import { start } from "workflow/api";
import { operationTag, runTag, type TaggedRun } from "./world-runs.ts";

export type WorkflowFunction = (input: unknown) => Promise<unknown>;

export interface StartIntent {
  readonly kind: string;
  readonly runId: string;
  readonly operationId: string;
}

export type StartOutcome =
  | { readonly kind: "accepted"; readonly receipt: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly evidence: string };

export interface StartParts {
  readonly runs: () => Promise<readonly TaggedRun[]>;
  readonly input: (runId: string) => Promise<string | undefined>;
  readonly workflow: (runId: string) => Promise<WorkflowFunction | undefined>;
}

export interface StartDelivery {
  readonly reconcile: (intent: StartIntent) => Promise<StartOutcome>;
  readonly deliver: (intent: StartIntent) => Promise<{
    readonly receipt: string;
  }>;
}

async function reconciled(
  parts: StartParts,
  intent: StartIntent,
): Promise<StartOutcome> {
  const found = (await parts.runs()).filter(
    (run) => run.operationId === intent.operationId,
  );
  const [first, ...others] = found;
  if (first === undefined) return { kind: "absent" };
  if (others.length === 0) return { kind: "accepted", receipt: first.receipt };
  return {
    kind: "unknown",
    evidence: found.map((run) => `world-run:${run.receipt}`).join(" "),
  };
}

async function delivered(
  parts: StartParts,
  intent: StartIntent,
): Promise<{ readonly receipt: string }> {
  if (intent.kind !== "start-run")
    throw new Error(`unsupported-intent: ${intent.kind}`);
  const workflow = await parts.workflow(intent.runId);
  const input = await parts.input(intent.runId);
  if (workflow === undefined || input === undefined)
    throw new Error(`start-not-available: ${intent.runId}`);
  const argument: unknown = JSON.parse(input);
  const started = await start(workflow, [argument], {
    attributes: {
      [runTag]: intent.runId,
      [operationTag]: intent.operationId,
    },
  });
  return { receipt: started.runId };
}

export function startDelivery(parts: StartParts): StartDelivery {
  return {
    reconcile: (intent) => reconciled(parts, intent),
    deliver: (intent) => delivered(parts, intent),
  };
}
