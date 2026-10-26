import {
  delivers,
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
  applied,
  identity,
  invalid,
  text,
  type Recorded,
  type Reduction,
} from "./reduction-state.ts";
import {
  terminal,
  transition,
  type AuthorityEvent,
  type AuthorityState,
  type EffectIntent,
} from "./transitions.ts";

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

export function gateDelivery(gate: SettledGate): EffectIntent {
  if (gate.wait !== "hook") return gateContinuation(gate);
  return {
    kind: "resume-hook",
    runId: gate.runId,
    operationId: identity({
      run: gate.runId,
      phase: "gate",
      round: gate.outcome.sequence,
      operation: "resume-hook",
      key: gate.gateId,
    }),
  };
}

function continuations(gate: GateState): readonly EffectIntent[] {
  return delivers(gate) ? [gateDelivery(gate)] : [];
}

export function opened(state: AuthorityState, recorded: Recorded): Reduction {
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

export function decided(state: AuthorityState, recorded: Recorded): Reduction {
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

export function expired(state: AuthorityState, recorded: Recorded): Reduction {
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

export function registered(
  state: AuthorityState,
  recorded: Recorded,
): Reduction {
  const { event, run } = recorded;
  if (terminal.includes(run.status)) return invalid("terminal-run");
  const gate = gateOf(state, event);
  if (gate === undefined) return invalid("unknown-gate");
  if (gate.wait !== "pending") return invalid("wait-already-registered");
  const next: GateState = { ...gate, wait: "registered" };
  return applied(state, {
    ...recorded,
    gates: [next],
    added: continuations(next),
  });
}
