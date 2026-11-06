import { operationStep } from "../operation-identity.ts";
import type { Continuation, Continuations, Operation } from "./operations.ts";
import type { RunState } from "./transitions.ts";

type Payload = Readonly<Record<string, string>>;

interface Admission {
  readonly sequence: number;
  readonly payload: Payload;
}

export function continuationOf(payload: Payload): Continuation | undefined {
  const runId = payload["continuedFrom"];
  const before = payload["reuseBefore"];
  if (runId === undefined || before === undefined) return undefined;
  return { runId, before: Number(before) };
}

export function continuationRefusal(
  runs: Readonly<Record<string, RunState>>,
  admission: Admission,
): string | undefined {
  const continuation = continuationOf(admission.payload);
  if (continuation === undefined) return undefined;
  const status = runs[continuation.runId]?.status;
  if (status === undefined) return "unknown-continued-run";
  if (status === "cancelled") return "continued-run-cancelled";
  if (status !== "failed" && status !== "completed")
    return "continued-run-active";
  if (continuation.before > admission.sequence)
    return "invalid-continuation-start";
  return undefined;
}

export function continuedRuns(
  continuations: Continuations | undefined,
  admission: Admission & { readonly runId: string },
): { readonly continuations?: Continuations } {
  const continuation = continuationOf(admission.payload);
  if (continuation === undefined)
    return continuations === undefined ? {} : { continuations };
  return {
    continuations: { ...continuations, [admission.runId]: continuation },
  };
}

const repeatedEffects: readonly (readonly [string, string])[] = [
  ["github", "label"],
];

function repeated(request: {
  readonly capability: string;
  readonly method: string;
}): boolean {
  return repeatedEffects.some(
    ([capability, method]) =>
      request.capability === capability && request.method === method,
  );
}

export function reusable(
  source: Operation | undefined,
  request: {
    readonly continuation: Continuation;
    readonly capability: string;
    readonly method: string;
  },
): source is Operation {
  return (
    source !== undefined &&
    !repeated(request) &&
    source.runId === request.continuation.runId &&
    source.status === "completed" &&
    source.requestedSequence < request.continuation.before &&
    source.capability === request.capability &&
    source.method === request.method
  );
}

export function reusedOperation(
  operation: Operation,
  source: Operation,
): Operation {
  return {
    ...operation,
    status: "completed",
    reason: null,
    waitSequence: null,
    receipt: source.receipt,
    worker: source.worker,
    result: source.result,
    settledSequence: operation.requestedSequence,
  };
}

export interface StoredOperation {
  readonly operationId: string;
  readonly status: string;
  readonly requestedSequence: number;
}

export type ContinuationStart =
  | { readonly kind: "start"; readonly reuseBefore: number }
  | { readonly kind: "refused"; readonly reason: string };

const stepName = /^([^/]+)\/([^/]+)(?:\/(0|[1-9][0-9]*))?$/;

function matcher(
  from: string | null,
): ((operation: StoredOperation) => boolean) | undefined {
  if (from === null) return (operation) => operation.status !== "completed";
  const parts = stepName.exec(from);
  if (parts === null) return undefined;
  const [, phase, name, round] = parts;
  return (operation) => {
    const step = operationStep(operation.operationId);
    if (step === null) return false;
    return (
      step.phase === phase &&
      step.operation === name &&
      (round === undefined || step.round === Number(round))
    );
  };
}

export function continuationStart(
  operations: readonly StoredOperation[],
  from: string | null,
): ContinuationStart {
  const matches = matcher(from);
  if (matches === undefined)
    return { kind: "refused", reason: "invalid-continuation-step" };
  const sequences = operations
    .filter(matches)
    .map((operation) => operation.requestedSequence);
  if (sequences.length > 0)
    return { kind: "start", reuseBefore: Math.min(...sequences) };
  return {
    kind: "refused",
    reason:
      from === null
        ? "continuation-step-required"
        : "unknown-continuation-step",
  };
}
