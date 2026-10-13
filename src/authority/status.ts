import type { Observation } from "./details.ts";
import { cancelled } from "./status-closure.ts";
import {
  effectEvidence,
  effectRecovery,
  effectViews,
  uncertainEffect,
  type EffectView,
  type Recovery,
} from "./status-effects.ts";
import {
  assessed,
  inFlight,
  last,
  type Assessment,
  type BudgetSummary,
  type OperationSummary,
  type StatusInput,
} from "./status-input.ts";
import type { RunStatus } from "./transitions.ts";

export { unresolved, unresolvedEffects } from "./status-closure.ts";
export type { EffectView } from "./status-effects.ts";
export type {
  Assessment,
  BudgetSummary,
  EffectSummary,
  OperationSummary,
  StatusInput,
} from "./status-input.ts";

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
  readonly recovery: Recovery;
  readonly budget: BudgetSummary | null;
  readonly effects: readonly EffectView[];
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
    "A dispatch has no known result. The service reconciles it and tries it again a limited count of times in the same opening, and again at its next start.",
  ],
  [
    "effect-recovering",
    "A protected effect has no known result. The service reconciles it before a new send.",
  ],
  [
    "effect-blocked",
    "A protected effect has no known result and its recovery bound is reached. A person must examine the effect.",
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
  [
    "stop-unconfirmed",
    "The run is dropped. The service asked for the stop of its work and got no confirmation. A person can confirm that the worker stopped.",
  ],
  ["world-run-failed", "The SDK run of this run failed in the World."],
  [
    "world-run-cancelled",
    "The SDK run of this run was cancelled in the World. Cloving did not ask for that.",
  ],
  [
    "world-run-waits-without-gate",
    "The SDK run of this run ended and waits for a decision, and the run has no open gate and no continuation.",
  ],
  [
    "world-run-conflict",
    "More than one SDK run has one operation of this run. Examine the World runs, then drop the run.",
  ],
  ["run-cancelled", "The run is dropped and has no work in progress."],
  ["run-completed", "The run completed."],
  ["run-failed", "The run failed."],
]);

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

function exhausted(observation: Observation): boolean {
  return (
    observation.attempt !== null &&
    observation.limit !== null &&
    observation.attempt >= observation.limit
  );
}

const unknownEffect = assessed("uncertain-effect", {
  code: "delivery-outcome-unknown",
  nextAction: "reconcile-effect",
  humanInputCanHelp: true,
});

function dispatched(operations: readonly OperationSummary[]): boolean {
  return operations.some((operation) => operation.outcomes.includes("sent"));
}

const unavailablePin = assessed("infrastructure-failure", {
  code: "pinned-workflow-unavailable",
  nextAction: "restore-pinned-workflow",
  humanInputCanHelp: true,
});

function worldConflict(input: StatusInput): Assessment | undefined {
  const code = input.details?.observation?.reason;
  if (code !== "world-run-conflict") return undefined;
  return assessed("infrastructure-failure", {
    code,
    nextAction: null,
    humanInputCanHelp: true,
  });
}

function queued(input: StatusInput): Assessment {
  if (uncertain(input.operations)) return unknownEffect;
  if (blocked(input.operations)) return unavailablePin;
  const conflict = worldConflict(input);
  if (conflict !== undefined) return conflict;
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
  const effect = uncertainEffect(input.effects);
  if (effect !== undefined) return effect;
  if (blocked(input.operations)) return unavailablePin;
  return worldConflict(input) ?? observed(input);
}

function observed(input: StatusInput): Assessment {
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

function worldEnd(input: StatusInput): string | undefined {
  const reason = input.details?.observation?.reason ?? "";
  return ["world-run-failed", "world-run-cancelled"].includes(reason)
    ? reason
    : undefined;
}

const assessments: Readonly<
  Record<RunStatus, (input: StatusInput) => Assessment>
> = {
  queued,
  running,
  waiting_gate: waiting,
  paused: (input) =>
    assessed("paused", {
      code: worldEnd(input) ?? "operator-pause",
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
    evidence: [
      ...evidence(observation),
      ...effectEvidence(input.effectEvidence),
    ],
    lastConfirmedObservation:
      observation === null
        ? null
        : {
            at: observation.recordedAt,
            sequence: observation.sequence,
            source: "worker",
          },
    recovery: effectRecovery(input.effects) ?? {
      attempts: observation?.attempt ?? 0,
      limit: observation?.limit ?? null,
    },
    budget: input.budget,
    effects: effectViews(input.effects),
    nextAction: assessment.nextAction,
    nextActionAt: assessment.nextActionAt ?? null,
    humanInputCanHelp: assessment.humanInputCanHelp,
  };
}
