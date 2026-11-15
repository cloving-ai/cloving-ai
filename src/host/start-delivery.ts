import { start } from "workflow/api";
import { operationTag, runTag, type TaggedRun } from "./world-runs.ts";
import {
  deliveredDecision,
  reconciledDecision,
  stoppedDecision,
} from "./decision-resume.ts";

export type WorkflowFunction = (...input: unknown[]) => Promise<unknown>;

export interface RunIntent {
  readonly gateId?: string;
  readonly decision?: string;
  readonly answer?: string | null;
  readonly kind: string;
  readonly runId: string;
  readonly operationId: string;
  readonly workflow: string;
}

export type RunOutcome =
  | { readonly kind: "accepted"; readonly receipt: string }
  | { readonly kind: "stopped"; readonly receipt: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly evidence: string };

type OperationRun = Pick<TaggedRun, "receipt" | "operationId" | "status">;

export interface StartParts {
  readonly isFeed?: (runId: string) => Promise<boolean>;
  readonly runs: () => Promise<readonly OperationRun[]>;
  readonly input: (runId: string) => Promise<string | undefined>;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly workflow: (
    intent: RunIntent,
  ) => Promise<WorkflowFunction | undefined>;
  readonly cancel: (receipt: string) => Promise<string>;
}

export interface StartDelivery {
  readonly reconcile: (intent: RunIntent) => Promise<RunOutcome>;
  readonly deliver: (
    intent: RunIntent,
    signal?: AbortSignal,
  ) => Promise<{
    readonly receipt: string;
  }>;
  readonly stop: (intent: RunIntent) => Promise<RunOutcome>;
}

const ends = ["cancelled", "completed", "failed"];

async function segments(
  parts: StartParts,
  intent: RunIntent,
): Promise<readonly OperationRun[]> {
  return (await parts.runs()).filter(
    (run) => run.operationId === intent.operationId,
  );
}

async function reconciled(
  parts: StartParts,
  intent: RunIntent,
): Promise<RunOutcome> {
  const found = await segments(parts, intent);
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
  intent: RunIntent,
): Promise<{ readonly receipt: string }> {
  if (intent.kind !== "start-run")
    throw new Error(`unsupported-intent: ${intent.kind}`);
  const workflow = await parts.workflow(intent);
  const input = await parts.input(intent.runId);
  if (workflow === undefined || input === undefined)
    throw new Error(`start-not-available: ${intent.runId}`);
  const argument: unknown = JSON.parse(input);
  const argumentsList = (await parts.isFeed?.(intent.runId)) ? [] : [argument];
  const started = await start(workflow, argumentsList, {
    attributes: {
      [runTag]: intent.runId,
      [operationTag]: intent.operationId,
    },
  });
  return { receipt: started.runId };
}

async function stopped(
  parts: StartParts,
  intent: RunIntent,
): Promise<RunOutcome> {
  const found = await segments(parts, intent);
  const [first] = found;
  if (first === undefined) return { kind: "absent" };
  const alive: string[] = [];
  for (const run of found.filter((run) => !ends.includes(run.status))) {
    const status = await parts.cancel(run.receipt);
    if (!ends.includes(status))
      alive.push(`world-run:${run.receipt} ${status}`);
  }
  if (alive.length > 0) return { kind: "unknown", evidence: alive.join(" ") };
  return { kind: "stopped", receipt: first.receipt };
}

export function startDelivery(parts: StartParts): StartDelivery {
  return {
    reconcile: (intent) =>
      intent.kind === "resume-hook"
        ? reconciledDecision(parts, intent)
        : reconciled(parts, intent),
    deliver: (intent, signal) =>
      intent.kind === "resume-hook"
        ? deliveredDecision(parts, { intent, signal })
        : delivered(parts, intent),
    stop: (intent) =>
      intent.kind === "resume-hook"
        ? stoppedDecision(parts, intent)
        : stopped(parts, intent),
  };
}
