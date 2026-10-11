import type { Observation, RunDetails } from "./details.ts";
import type { GateState } from "./gates.ts";
import type { RunState, RunStatus } from "./transitions.ts";

export interface OperationSummary {
  readonly operationId: string;
  readonly kind: "start-run" | "continue-run";
  readonly releasedSequence: number | null;
  readonly outcomes: readonly (string | null)[];
}

export interface StatusInput {
  readonly run: RunState;
  readonly details: RunDetails | undefined;
  readonly gates: readonly GateState[];
  readonly operations: readonly OperationSummary[];
  readonly latestSequence: number;
  readonly silent: boolean;
}

export interface Assessment {
  readonly condition: string;
  readonly code: string;
  readonly nextAction: string | null;
  readonly nextActionAt?: string | null;
  readonly detail?: string;
  readonly humanInputCanHelp: boolean;
}

export interface RunView {
  readonly runId: string;
  readonly workflow: string;
  readonly state: RunStatus;
  readonly condition: string;
  readonly revision: number;
  readonly latestSequence: number;
  readonly pendingDecisions: readonly string[];
  readonly reason: { readonly code: string; readonly detail: string };
  readonly evidence: readonly string[];
  readonly lastConfirmedObservation: {
    readonly at: string;
    readonly sequence: number;
    readonly source: string;
  } | null;
  readonly recovery: {
    readonly attempts: number;
    readonly limit: number | null;
  };
  readonly nextAction: string | null;
  readonly nextActionAt: string | null;
  readonly humanInputCanHelp: boolean;
}

const details = new Map<string, string>([
  ["awaiting-dispatch", "The run waits for its first dispatch."],
  ["dispatch-in-progress", "A dispatch of the run is in progress."],
  [
    "start-not-reported",
    "The start is sent. The worker did not report its start.",
  ],
  ["in-progress", "The run is in work."],
  [
    "no-recent-observation",
    "No observation arrived in the liveness period. Silence alone is not a failure.",
  ],
  [
    "delivery-outcome-unknown",
    "A dispatch has no known result. The service reconciles it and tries it again at the next command of the run or at its next start.",
  ],
  [
    "pinned-workflow-unavailable",
    "The installed workflow is not the workflow that the run pinned. The continuation is not sent.",
  ],
  ["operator-pause", "The operator paused the run."],
  ["design-question", "A design question waits for an answer."],
  ["policy-approval", "A configured approval waits for a decision."],
  ["gate-open", "A gate of the run is open."],
  [
    "delivery-in-flight",
    "The run is dropped. A dispatch is in flight and has no result yet.",
  ],
  [
    "stop-not-observed",
    "The run is dropped. The stop of its dispatched work is not observed yet.",
  ],
  ["run-cancelled", "The run is dropped and has no work in progress."],
  ["run-completed", "The run completed."],
  ["run-failed", "The run failed."],
]);

function last(operation: OperationSummary): string | null | undefined {
  return operation.outcomes.at(-1);
}

function inFlight(operations: readonly OperationSummary[]): boolean {
  return operations.some((operation) => last(operation) === null);
}

function uncertain(operations: readonly OperationSummary[]): boolean {
  return operations.some(
    (operation) =>
      operation.releasedSequence === null &&
      ["failed", "stale-epoch"].includes(last(operation) ?? ""),
  );
}

function blocked(operations: readonly OperationSummary[]): boolean {
  return operations.some(
    (operation) =>
      operation.releasedSequence === null && last(operation) === "blocked",
  );
}

const unknownResults: readonly (string | null)[] = [
  null,
  "failed",
  "stale-epoch",
];

export function unresolved(
  operations: readonly OperationSummary[],
): readonly string[] {
  return operations
    .filter(
      (operation) =>
        !operation.outcomes.includes("sent") &&
        operation.outcomes.some((outcome) => unknownResults.includes(outcome)),
    )
    .map((operation) => operation.operationId);
}

function stoppedOperation(input: StatusInput): string | null {
  const observation = input.details?.observation ?? null;
  return observation?.condition === "stopped" ? observation.operationId : null;
}

function lastDispatched(
  operations: readonly OperationSummary[],
): OperationSummary | undefined {
  return operations
    .filter((operation) => operation.outcomes.includes("sent"))
    .sort(
      (left, right) =>
        (left.releasedSequence ?? 0) - (right.releasedSequence ?? 0),
    )
    .at(-1);
}

function stopPending(input: StatusInput): boolean {
  const last = lastDispatched(input.operations);
  return last !== undefined && stoppedOperation(input) !== last.operationId;
}

export function unresolvedEffects(input: StatusInput): readonly string[] {
  const stopped = stoppedOperation(input);
  return unresolved(input.operations).filter(
    (operationId) => operationId !== stopped,
  );
}

function exhausted(observation: Observation): boolean {
  return (
    observation.attempt !== null &&
    observation.limit !== null &&
    observation.attempt >= observation.limit
  );
}

function assessed(
  condition: string,
  rest: Omit<Assessment, "condition">,
): Assessment {
  return { condition, ...rest };
}

const unknownEffect = assessed("uncertain-effect", {
  code: "delivery-outcome-unknown",
  nextAction: "reconcile-effect",
  humanInputCanHelp: true,
});

function dispatched(operations: readonly OperationSummary[]): boolean {
  return operations.some((operation) => operation.outcomes.includes("sent"));
}

function queued(input: StatusInput): Assessment {
  if (uncertain(input.operations)) return unknownEffect;
  if (dispatched(input.operations))
    return assessed("queued", {
      code: "start-not-reported",
      nextAction: null,
      humanInputCanHelp: false,
    });
  const progress = inFlight(input.operations);
  return assessed("queued", {
    code: progress ? "dispatch-in-progress" : "awaiting-dispatch",
    nextAction: progress ? null : "dispatch",
    humanInputCanHelp: false,
  });
}

const observedActions: Readonly<Record<string, string>> = {
  "quota-wait": "recheck-eligibility",
  "infrastructure-failure": "retry-operation",
  "code-failure": "repair-code",
};

function observedWork(observation: Observation): Assessment {
  const spent =
    observation.condition !== "quota-wait" && exhausted(observation);
  return assessed(observation.condition, {
    code: observation.reason,
    nextAction: spent ? null : (observedActions[observation.condition] ?? null),
    nextActionAt: spent ? null : observation.retryAt,
    humanInputCanHelp: spent,
  });
}

function running(input: StatusInput): Assessment {
  if (uncertain(input.operations)) return unknownEffect;
  if (blocked(input.operations))
    return assessed("infrastructure-failure", {
      code: "pinned-workflow-unavailable",
      nextAction: "restore-pinned-workflow",
      humanInputCanHelp: true,
    });
  const observation = input.details?.observation ?? null;
  if (
    observation !== null &&
    Object.hasOwn(observedActions, observation.condition)
  )
    return observedWork(observation);
  if (input.silent)
    return assessed("working", {
      code: "no-recent-observation",
      nextAction: "reconcile-worker",
      humanInputCanHelp: false,
    });
  return assessed("working", {
    code: observation?.reason ?? "in-progress",
    nextAction: null,
    humanInputCanHelp: false,
  });
}

function waiting(input: StatusInput): Assessment {
  const pending = input.gates.filter((gate) => gate.outcome === null);
  const question = pending.some((gate) => gate.kind === "question");
  const approval = pending.some((gate) => gate.kind === "approval");
  if (!question && !approval)
    return assessed("waiting-decision", {
      code: "gate-open",
      nextAction: null,
      humanInputCanHelp: true,
    });
  return assessed("waiting-decision", {
    code: question ? "design-question" : "policy-approval",
    nextAction: question ? "answer" : "approve-or-deny",
    humanInputCanHelp: true,
  });
}

function cancelled(input: StatusInput): Assessment {
  if (inFlight(input.operations))
    return assessed("cancelling", {
      code: "delivery-in-flight",
      nextAction: "reconcile-effect",
      humanInputCanHelp: false,
    });
  if (unresolvedEffects(input).length > 0)
    return assessed("cancelling", {
      code: "delivery-outcome-unknown",
      detail:
        "The run is dropped. A dispatch has no known result. A stop report of that operation or a later reconciliation resolves it.",
      nextAction: "reconcile-effect",
      humanInputCanHelp: false,
    });
  if (stopPending(input))
    return assessed("cancelling", {
      code: "stop-not-observed",
      nextAction: "observe-worker-stop",
      humanInputCanHelp: false,
    });
  return assessed("cancelled", {
    code: "run-cancelled",
    nextAction: null,
    humanInputCanHelp: false,
  });
}

const assessments: Readonly<
  Record<RunStatus, (input: StatusInput) => Assessment>
> = {
  queued,
  running,
  waiting_gate: waiting,
  paused: () =>
    assessed("paused", {
      code: "operator-pause",
      nextAction: "resume",
      humanInputCanHelp: true,
    }),
  completed: () =>
    assessed("completed", {
      code: "run-completed",
      nextAction: null,
      humanInputCanHelp: false,
    }),
  failed: (input) =>
    assessed("failed", {
      code: input.details?.observation?.reason ?? "run-failed",
      nextAction: null,
      humanInputCanHelp: true,
    }),
  cancelled,
};

function evidence(observation: Observation | null): readonly string[] {
  if (observation === null) return [];
  const reference = observation.evidence === null ? [] : [observation.evidence];
  return [`event:${String(observation.sequence)}`, ...reference];
}

function reasonOf(assessment: Assessment): RunView["reason"] {
  return {
    code: assessment.code,
    detail:
      assessment.detail ??
      details.get(assessment.code) ??
      "A worker reported this reason.",
  };
}

export function runView(input: StatusInput): RunView {
  const { run } = input;
  const observation = input.details?.observation ?? null;
  const assessment = assessments[run.status](input);
  return {
    runId: run.runId,
    workflow: run.workflow,
    state: run.status,
    condition: assessment.condition,
    revision: run.revision,
    latestSequence: input.latestSequence,
    pendingDecisions: input.gates
      .filter((gate) => gate.outcome === null)
      .map((gate) => `${gate.runId}/${gate.gateId}`),
    reason: reasonOf(assessment),
    evidence: evidence(observation),
    lastConfirmedObservation:
      observation === null
        ? null
        : {
            at: observation.recordedAt,
            sequence: observation.sequence,
            source: "worker",
          },
    recovery: {
      attempts: observation?.attempt ?? 0,
      limit: observation?.limit ?? null,
    },
    nextAction: assessment.nextAction,
    nextActionAt: assessment.nextActionAt ?? null,
    humanInputCanHelp: assessment.humanInputCanHelp,
  };
}
