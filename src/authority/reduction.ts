import { operationIdentity } from "../operation-identity.ts";
import {
  admittedDetails,
  continued,
  observed,
  type RunDetails,
} from "./details.ts";
import {
  continues,
  decisionRefusal,
  expiryRefusal,
  gateKey,
  openedGate,
  reusable,
  settled,
  type GateOutcome,
  type GateState,
  type SettledGate,
} from "./gates.ts";
import {
  terminal,
  transition,
  type AuthorityEvent,
  type AuthorityState,
  type EffectIntent,
  type Move,
  type RunState,
} from "./transitions.ts";

interface Applied {
  readonly kind: "applied";
  readonly state: AuthorityState;
  readonly intents: readonly EffectIntent[];
}

export type Reduction =
  Applied | { readonly kind: "invalid"; readonly reason: string };

interface Recorded {
  readonly event: AuthorityEvent;
  readonly commands: AuthorityState["commands"];
  readonly run: RunState;
  readonly details: RunDetails;
}

interface Change extends Recorded {
  readonly moved?: RunState;
  readonly gates?: readonly GateState[];
  readonly added?: readonly EffectIntent[];
  readonly questions?: number;
  readonly observed?: RunDetails;
}

type Handler = (state: AuthorityState, recorded: Recorded) => Reduction;

function invalid(reason: string): Reduction {
  return { kind: "invalid", reason };
}

function text(event: AuthorityEvent, name: string): string {
  return event.payload[name] ?? "";
}

function identity(scope: Readonly<Record<string, unknown>>): string {
  const result = operationIdentity(scope);
  return result.kind === "valid" ? result.value : "";
}

export function gateContinuation(gate: SettledGate): EffectIntent {
  return {
    kind: "continue-run",
    runId: gate.runId,
    operationId: identity({
      run: gate.runId,
      phase: "gate",
      round: gate.outcome.sequence,
      operation: "continue-run",
      key: gate.gateId,
    }),
  };
}

function continuations(gate: GateState): readonly EffectIntent[] {
  return continues(gate) ? [gateContinuation(gate)] : [];
}

function retained(
  intents: readonly EffectIntent[],
  event: AuthorityEvent,
): readonly EffectIntent[] {
  if (["run.cancelled", "run.failed", "run.completed"].includes(event.type))
    return intents.filter((intent) => intent.runId !== event.runId);
  if (event.type === "run.started")
    return intents.filter(
      (intent) => intent.runId !== event.runId || intent.kind !== "start-run",
    );
  return intents;
}

function applied(state: AuthorityState, change: Change): Applied {
  const { event, added = [] } = change;
  const details = change.observed ?? change.details;
  return {
    kind: "applied",
    state: {
      sequence: event.sequence,
      runs: change.moved
        ? { ...state.runs, [event.runId]: change.moved }
        : state.runs,
      commands: change.commands,
      intents: [...retained(state.intents, event), ...added],
      gates: {
        ...state.gates,
        ...Object.fromEntries(
          (change.gates ?? []).map((gate) => [
            gateKey(gate.runId, gate.gateId),
            gate,
          ]),
        ),
      },
      details: {
        ...state.details,
        [event.runId]: added.length > 0 ? continued(details) : details,
      },
      questions: change.questions ?? state.questions,
    },
    intents: added,
  };
}

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

function opened(state: AuthorityState, recorded: Recorded): Reduction {
  const { event, run } = recorded;
  const result = transition(run, {
    type: "gate.opened",
    gateId: text(event, "gateId"),
  });
  if (result.kind === "invalid") return result;
  const question = event.payload["gateKind"] === "question";
  const questions = state.questions + (question ? 1 : 0);
  const gate = openedGate({
    runId: event.runId,
    sequence: event.sequence,
    payload: event.payload,
    generation: recorded.details.generation,
    label: question ? questions : null,
  });
  if (!reusable(gateOf(state, event), gate)) return invalid("existing-gate");
  return applied(state, {
    ...recorded,
    moved: result.run,
    questions,
    gates: [gate],
  });
}

function concluded(
  state: AuthorityState,
  conclusion: Recorded & {
    readonly gate: GateState;
    readonly outcome: GateOutcome;
  },
): Reduction {
  const { run, gate, outcome } = conclusion;
  const result = transition(run, { type: "gate.decided", gateId: gate.gateId });
  if (result.kind === "invalid") return result;
  const next = settled(gate, outcome);
  return applied(state, {
    ...conclusion,
    moved: result.run,
    gates: [next],
    added: continuations(next),
  });
}

function gateOf(
  state: AuthorityState,
  event: AuthorityEvent,
): GateState | undefined {
  return state.gates[gateKey(event.runId, text(event, "gateId"))];
}

function decided(state: AuthorityState, recorded: Recorded): Reduction {
  const { event } = recorded;
  const gate = gateOf(state, event);
  if (gate === undefined) return invalid("unknown-gate");
  const refusal = decisionRefusal(gate, event);
  if (refusal !== undefined) return invalid(refusal);
  return concluded(state, {
    ...recorded,
    gate,
    outcome: {
      decision: text(event, "decision"),
      answer: event.payload["answer"] ?? null,
      sequence: event.sequence,
    },
  });
}

function expired(state: AuthorityState, recorded: Recorded): Reduction {
  const { event } = recorded;
  const gate = gateOf(state, event);
  if (gate === undefined) return invalid("unknown-gate");
  const refusal = expiryRefusal(gate, event.recordedAt);
  if (refusal !== undefined) return invalid(refusal);
  return concluded(state, {
    ...recorded,
    gate,
    outcome: { decision: "expired", answer: null, sequence: event.sequence },
  });
}

function registered(state: AuthorityState, recorded: Recorded): Reduction {
  const { event, run } = recorded;
  if (terminal.includes(run.status)) return invalid("terminal-run");
  const gate = gateOf(state, event);
  if (gate === undefined) return invalid("unknown-gate");
  if (gate.wait === "registered") return invalid("wait-already-registered");
  const next: GateState = { ...gate, wait: "registered" };
  return applied(state, {
    ...recorded,
    gates: [next],
    added: continuations(next),
  });
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

const handlers: Readonly<Record<string, Handler>> = {
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
