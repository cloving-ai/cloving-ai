import { execute, type AuthorityState } from "../../authority/reducer.ts";
import { operationDigest } from "../operation-digest.ts";
import { followUps, outcomeCommand, resultDocuments } from "./effect-plan.ts";
import {
  draft,
  merged,
  unchanged,
  type Accepted,
  type ChangeDraft,
  type Row,
} from "./turn-draft.ts";
import { followUp, openAttempts, staged } from "./turn-staging.ts";
import type {
  DeliveryPlanning,
  DeliveryResult,
  TurnPlan,
  TurnState,
} from "./turn-staging.ts";

function closedAs(outcome: string): string {
  return outcome === "thrown" ? "failed" : outcome;
}

interface Closing {
  readonly turn: TurnState;
  readonly delivery: DeliveryResult;
  readonly outcome: string;
  readonly retried: boolean;
}

function heldAfter(
  closing: Closing,
  result: Accepted | undefined,
): ReadonlySet<string> {
  const { turn, delivery, outcome } = closing;
  const settled = result !== undefined || closing.retried;
  if (!settled && quiet.includes(outcome)) return turn.held;
  return new Set(
    [...turn.held].filter((operation) => operation !== delivery.operationId),
  );
}

function blockedAfter(closing: Closing): ReadonlyMap<string, string> {
  const { turn, delivery, outcome } = closing;
  if (outcome !== "blocked") return turn.blocked;
  return new Map([...turn.blocked, [delivery.operationId, delivery.effectId]]);
}

function closedDraft(
  closing: Closing,
  result: Accepted | undefined,
): ChangeDraft {
  const { turn, delivery, outcome } = closing;
  const closed = [
    {
      effect_id: delivery.effectId,
      outcome: closedAs(outcome),
      receipt: delivery.receipt,
    },
  ];
  if (result === undefined) return unchanged(turn.state, closed);
  return draft(result, {
    before: turn.state,
    definitions: [],
    closed,
    documents: resultDocuments(delivery),
  });
}

export function planDelivery(planning: DeliveryPlanning): TurnPlan {
  const { turn, delivery, epoch } = planning;
  const outcome = delivery.epoch === epoch ? delivery.outcome : "stale-epoch";
  const closing = {
    turn,
    delivery,
    outcome,
    retried:
      retriable.includes(outcome) &&
      delivery.intent !== "protected-effect" &&
      delivery.attempts < planning.effects.deliveryAttempts,
  };
  const result = recorded(turn.state, { ...delivery, outcome });
  const base = result?.state ?? turn.state;
  const steps = followUps(base, {
    recordedAt: delivery.recordedAt,
    effects: planning.effects,
    blocked: blockedAfter(closing),
  });
  return {
    kind: "commit",
    receipt: { kind: outcome },
    change: merged(closedDraft(closing, result), steps.map(followUp)),
    stage: staged(steps.at(-1)?.result.state ?? base, {
      held: heldAfter(closing, result),
      results: [
        ...(result === undefined ? [] : [result]),
        ...steps.map((step) => step.result),
      ],
      closed: [delivery.operationId],
      open: openAttempts(turn, [delivery.operationId]),
      stop: {
        ...planning,
        rows: [{ effectId: delivery.effectId, outcome: closedAs(outcome) }],
      },
    }),
  };
}

const quiet = ["thrown", "failed", "blocked"];
const retriable = ["thrown", "failed"];

type Closed = Omit<DeliveryResult, "outcome"> & { readonly outcome: string };

function recorded(
  state: AuthorityState,
  delivery: Closed,
): Accepted | undefined {
  const command =
    delivery.intent === "protected-effect"
      ? outcomeCommand({
          ...delivery,
          storedReceipt:
            state.effects.operations[delivery.operationId]?.receipt ?? null,
        })
      : dispatchCommand(delivery);
  if (command === undefined) return undefined;
  const result = execute(state, { command, recordedAt: delivery.recordedAt });
  return result.kind === "accepted" ? result : undefined;
}

const runCommands: Readonly<Record<string, (delivery: Closed) => Row>> = {
  sent: (delivery) => ({
    kind: "record-dispatch",
    commandId: `dispatch:${operationDigest(delivery.operationId)}`,
    runId: delivery.runId,
    operationId: delivery.operationId,
    receipt: delivery.receipt,
  }),
  stopped: (delivery) => ({
    kind: "record-outcome",
    commandId: `outcome:${delivery.effectId}`,
    runId: delivery.runId,
    operationId: delivery.operationId,
    outcome: "stopped",
  }),
};

function dispatchCommand(delivery: Closed): Row | undefined {
  return runCommands[delivery.outcome]?.(delivery);
}
