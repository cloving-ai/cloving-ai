import type { AuthorityState } from "../../authority/reducer.ts";
import {
  stopAttempts,
  type StopAttempt,
  type StopSubject,
} from "../../authority/stop-sequence.ts";
import {
  observingIntent,
  protectedIntent,
  type DeliveryIntent,
} from "./delivery-intents.ts";
import type { Stopping } from "./stop-turn.ts";

export interface ClosedRow {
  readonly effectId: string;
  readonly outcome: string;
}

export interface StopPlanning {
  readonly stopping: Stopping;
  readonly runId: string;
  readonly closed: readonly ClosedRow[];
  readonly cancelledNow: readonly number[];
  readonly stopLimit: number;
  readonly stopSupported: boolean;
  readonly opening: boolean;
  readonly rejected: ReadonlySet<string>;
}

function present(
  state: AuthorityState,
  planning: Pick<StopPlanning, "closed"> & { readonly subject: StopSubject },
): StopSubject {
  const { subject, closed } = planning;
  const operation = state.effects.operations[subject.operationId];
  return {
    ...subject,
    attempts: subject.attempts.map((attempt) => ({
      ...attempt,
      outcome:
        closed.find((row) => row.effectId === attempt.effectId)?.outcome ??
        attempt.outcome,
    })),
    status: operation?.status ?? subject.status,
    receipt: operation?.receipt ?? subject.receipt,
    stopped:
      subject.stopped || state.effects.stops[subject.operationId] !== undefined,
  };
}

const kinds = ["start-run", "continue-run", "resume-hook"] as const;

function intentOf(
  state: AuthorityState,
  attempt: StopAttempt & { readonly runId: string },
): readonly DeliveryIntent[] {
  const { runId, operationId, purpose } = attempt;
  const kind = kinds.find((candidate) => candidate === attempt.kind);
  if (kind === undefined)
    return protectedIntent(state, {
      intent: { kind: "protected-effect", runId, operationId },
      purpose,
    });
  return [
    observingIntent(state, { intent: { kind, runId, operationId }, purpose }),
  ];
}

export function presentSubjects(
  state: AuthorityState,
  planning: Pick<StopPlanning, "stopping" | "closed">,
): readonly StopSubject[] {
  return planning.stopping.subjects.map((subject) =>
    present(state, { subject, closed: planning.closed }),
  );
}

export function stopIntents(
  state: AuthorityState,
  planning: StopPlanning,
): readonly DeliveryIntent[] {
  const { runId, stopping } = planning;
  if (state.runs[runId]?.status !== "cancelled") return [];
  const subjects = presentSubjects(state, planning);
  return stopAttempts(subjects, {
    cancelledSequence:
      planning.cancelledNow[0] ?? stopping.cancelledSequence ?? 0,
    stopLimit: planning.stopLimit,
    stopSupported: planning.stopSupported,
    opening: planning.opening,
    rejected: planning.rejected,
  }).flatMap((attempt) => intentOf(state, { ...attempt, runId }));
}
