import { start } from "workflow/api";
import { operationTag, runTag, type TaggedRun } from "./world-runs.ts";

export type WorkflowFunction = (
  input: unknown,
  continuation?: Continuation,
) => Promise<unknown>;

export interface Continuation {
  readonly gateId: string;
  readonly decision: string;
  readonly answer: string | null;
}

export interface RunIntent extends Partial<Continuation> {
  readonly kind: string;
  readonly runId: string;
  readonly operationId: string;
}

export type RunOutcome =
  | { readonly kind: "accepted"; readonly receipt: string }
  | { readonly kind: "stopped"; readonly receipt: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly evidence: string };

type OperationRun = Pick<TaggedRun, "receipt" | "operationId" | "status">;

export interface StartParts {
  readonly runs: () => Promise<readonly OperationRun[]>;
  readonly input: (runId: string) => Promise<string | undefined>;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly workflow: (runId: string) => Promise<WorkflowFunction | undefined>;
  readonly cancel: (receipt: string) => Promise<string>;
}

export interface StartDelivery {
  readonly reconcile: (intent: RunIntent) => Promise<RunOutcome>;
  readonly deliver: (intent: RunIntent) => Promise<{
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

async function continuation(
  parts: StartParts,
  intent: RunIntent,
): Promise<Continuation | undefined> {
  const { kind, gateId, decision, answer } = intent;
  if (kind === "start-run") return undefined;
  if (kind !== "continue-run" || gateId === undefined || decision === undefined)
    throw new Error(`unsupported-intent: ${kind}`);
  if (answer === undefined || answer === null)
    return { gateId, decision, answer: null };
  const text = await parts.document(answer);
  if (text === undefined) throw new Error(`answer-not-available: ${gateId}`);
  return { gateId, decision, answer: text };
}

async function delivered(
  parts: StartParts,
  intent: RunIntent,
): Promise<{ readonly receipt: string }> {
  const continued = await continuation(parts, intent);
  const workflow = await parts.workflow(intent.runId);
  const input = await parts.input(intent.runId);
  if (workflow === undefined || input === undefined)
    throw new Error(`start-not-available: ${intent.runId}`);
  const argument: unknown = JSON.parse(input);
  const started = await start(workflow, [argument, continued], {
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
    reconcile: (intent) => reconciled(parts, intent),
    deliver: (intent) => delivered(parts, intent),
    stop: (intent) => stopped(parts, intent),
  };
}
