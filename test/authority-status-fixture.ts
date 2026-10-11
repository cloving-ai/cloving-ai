import type { Observation } from "../src/authority/details.ts";
import type { GateState } from "../src/authority/gates.ts";
import type { RunState, RunStatus } from "../src/authority/reducer.ts";
import type { OperationSummary, StatusInput } from "../src/authority/status.ts";

function run(status: RunStatus): RunState {
  return {
    runId: "run-1",
    status,
    revision: 4,
    workflow: "pin-1",
    pausedFrom: null,
    gates: [],
  };
}

export function observation(fields: Partial<Observation>): Observation {
  return {
    condition: "working",
    reason: "progress",
    evidence: null,
    retryAt: null,
    operationId: null,
    attempt: null,
    limit: null,
    sequence: 7,
    recordedAt: "2026-10-10T12:00:00.000Z",
    ...fields,
  };
}

export function gate(kind: GateState["kind"]): GateState {
  return {
    runId: "run-1",
    gateId: `${kind}-1`,
    kind,
    label: kind === "question" ? 3 : null,
    subject: null,
    prompt: null,
    expiresAt: null,
    generation: 1,
    revision: 1,
    wait: "registered",
    outcome: null,
    openedSequence: 5,
  };
}

export function input(fields: {
  readonly status: RunStatus;
  readonly observed?: Partial<Observation>;
  readonly gates?: readonly GateState[];
  readonly operations?: readonly OperationSummary[];
  readonly silent?: boolean;
}): StatusInput {
  return {
    run: run(fields.status),
    details: {
      runId: "run-1",
      generation: 1,
      submission: null,
      input: null,
      resolver: null,
      observation: fields.observed ? observation(fields.observed) : null,
    },
    gates: fields.gates ?? [],
    operations: fields.operations ?? [],
    latestSequence: 9,
    silent: fields.silent ?? false,
  };
}

export const start =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';
export const continuation =
  '["cloving-operation",6,"run-1","gate","continue-run",null,"design-1"]';

export const sent: OperationSummary = {
  operationId: start,
  kind: "start-run",
  releasedSequence: 2,
  outcomes: ["sent"],
};
export const open: OperationSummary = {
  operationId: start,
  kind: "start-run",
  releasedSequence: null,
  outcomes: [null],
};
export const unknown: OperationSummary = {
  operationId: continuation,
  kind: "continue-run",
  releasedSequence: null,
  outcomes: ["failed"],
};
