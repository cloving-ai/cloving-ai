import { admittedDetails, observed } from "./details.ts";
import { settled } from "./gates.ts";
import { admittedBudgets } from "./budgets.ts";
import { requested } from "./effect-requests.ts";
import { reconciled, reported, stopReported } from "./effect-results.ts";
import { decided, expired, opened, registered } from "./gate-reduction.ts";
import { expired as leaseExpired, granted } from "./leases.ts";
import type { EffectContext, EffectResult, EffectState } from "./operations.ts";
import {
  applied,
  identity,
  invalid,
  text,
  type Handler,
  type Recorded,
  type Reduction,
} from "./reduction-state.ts";
import {
  transition,
  type AuthorityEvent,
  type AuthorityState,
  type EffectIntent,
  type Move,
} from "./transitions.ts";

export { gateContinuation } from "./gate-reduction.ts";
export type { Reduction } from "./reduction-state.ts";

function moved(type: Move): Handler {
  return (state, recorded) => {
    const result = transition(recorded.run, {
      type,
      gateId: text(recorded.event, "gateId"),
    });
    if (result.kind === "invalid") return result;
    return applied(state, { ...recorded, moved: result.run });
  };
}

function closed(type: "run.cancelled" | "run.failed"): Handler {
  return (state, recorded) => {
    const { event, run } = recorded;
    const result = transition(run, { type, gateId: "" });
    if (result.kind === "invalid") return result;
    const outcome = { decision: null, answer: null, sequence: event.sequence };
    return applied(state, {
      ...recorded,
      moved: result.run,
      gates: Object.values(state.gates)
        .filter((gate) => gate.runId === run.runId && gate.outcome === null)
        .map((gate) => settled(gate, outcome)),
    });
  };
}

function observation(state: AuthorityState, recorded: Recorded): Reduction {
  return applied(state, {
    ...recorded,
    observed: observed(recorded.details, recorded.event),
    effects: stopReported(state.effects, recorded.event),
  });
}

function dispatched(state: AuthorityState, recorded: Recorded): Reduction {
  const operationId = text(recorded.event, "operationId");
  const remaining = state.intents.filter(
    (intent) =>
      intent.runId !== recorded.event.runId ||
      intent.operationId !== operationId,
  );
  if (remaining.length === state.intents.length)
    return invalid("unknown-intent");
  return applied({ ...state, intents: remaining }, recorded);
}

type EffectRule = (
  effects: EffectState,
  context: EffectContext,
) => EffectResult;

function effect(rule: EffectRule): Handler {
  return (state, recorded) => {
    const { event, run } = recorded;
    const result = rule(state.effects, { event, runStatus: run.status });
    if (result.kind === "invalid") return result;
    const present = new Set(state.intents.map((intent) => intent.operationId));
    return applied(state, {
      ...recorded,
      effects: result.effects,
      ...(result.released === undefined ? {} : { released: result.released }),
      ...(result.disposition === undefined
        ? {}
        : { disposition: result.disposition }),
      added: (result.added ?? [])
        .filter((operationId) => !present.has(operationId))
        .map((operationId) => ({
          kind: "protected-effect",
          runId: event.runId,
          operationId,
        })),
    });
  };
}

const handlers: Readonly<Record<string, Handler>> = {
  "effect.requested": effect(requested),
  "lease.granted": effect(granted),
  "lease.expired": effect(leaseExpired),
  "effect.reported": effect(reported),
  "operation.reconciled": effect(reconciled),
  "run.started": moved("run.started"),
  "run.paused": moved("run.paused"),
  "run.resumed": moved("run.resumed"),
  "run.completed": moved("run.completed"),
  "run.cancelled": closed("run.cancelled"),
  "run.failed": closed("run.failed"),
  "run.observed": observation,
  "gate.opened": opened,
  "gate.wait-registered": registered,
  "gate.decided": decided,
  "gate.expired": expired,
  "step.dispatched": dispatched,
};

function created(
  state: AuthorityState,
  recorded: Pick<Recorded, "event" | "commands">,
): Reduction {
  const { event, commands } = recorded;
  if (state.runs[event.runId]) return invalid("existing-run");
  const intent: EffectIntent = {
    kind: "start-run",
    runId: event.runId,
    operationId: identity({
      run: event.runId,
      phase: "admission",
      round: 0,
      operation: "start-run",
    }),
  };
  return {
    kind: "applied",
    state: {
      ...state,
      sequence: event.sequence,
      runs: {
        ...state.runs,
        [event.runId]: {
          runId: event.runId,
          status: "queued",
          revision: 1,
          workflow: text(event, "workflow"),
          pausedFrom: null,
          gates: [],
        },
      },
      commands,
      intents: [...state.intents, intent],
      details: {
        ...state.details,
        [event.runId]: admittedDetails(event.runId, event.payload),
      },
      effects: {
        ...state.effects,
        budgets: admittedBudgets(state.effects.budgets, event),
      },
    },
    intents: [intent],
  };
}

export function reduce(
  state: AuthorityState,
  event: AuthorityEvent,
): Reduction {
  if (event.sequence !== state.sequence + 1) return invalid("sequence-gap");
  if (state.commands[event.commandId]) return invalid("duplicate-command");
  const commands = {
    ...state.commands,
    [event.commandId]: { request: event.request, sequence: event.sequence },
  };
  const handler = handlers[event.type];
  if (handler === undefined) return created(state, { event, commands });
  const run = state.runs[event.runId];
  const details = state.details[event.runId];
  if (!run || !details) return invalid("unknown-run");
  return handler(state, { event, commands, run, details });
}
