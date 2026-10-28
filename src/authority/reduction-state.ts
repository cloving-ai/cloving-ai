import { closedCommandWaits, type CommandWaitsState } from "./command-waits.ts";
import { operationIdentity } from "../operation-identity.ts";
import { continued, type RunDetails } from "./details.ts";
import { gateKey, type GateState } from "./gates.ts";
import { endedRun, type Disposition, type EffectState } from "./operations.ts";
import type {
  AuthorityEvent,
  AuthorityState,
  EffectIntent,
  RunState,
} from "./transitions.ts";

export interface Applied {
  readonly kind: "applied";
  readonly state: AuthorityState;
  readonly intents: readonly EffectIntent[];
  readonly disposition?: Disposition;
}

export type Reduction =
  Applied | { readonly kind: "invalid"; readonly reason: string };

export interface Recorded {
  readonly event: AuthorityEvent;
  readonly commands: AuthorityState["commands"];
  readonly run: RunState;
  readonly details: RunDetails;
}

export interface Change extends Recorded {
  readonly moved?: RunState;
  readonly commandWaits?: CommandWaitsState;
  readonly gates?: readonly GateState[];
  readonly added?: readonly EffectIntent[];
  readonly questions?: number;
  readonly observed?: RunDetails;
  readonly effects?: EffectState;
  readonly released?: readonly string[];
  readonly disposition?: Disposition;
}

export type Handler = (state: AuthorityState, recorded: Recorded) => Reduction;

export function invalid(reason: string): Reduction {
  return { kind: "invalid", reason };
}

export function text(event: AuthorityEvent, name: string): string {
  return event.payload[name] ?? "";
}

export function identity(scope: Readonly<Record<string, unknown>>): string {
  const result = operationIdentity(scope);
  return result.kind === "valid" ? result.value : "";
}

const ended = ["run.cancelled", "run.failed", "run.completed"];

export function retained(
  intents: readonly EffectIntent[],
  event: AuthorityEvent,
): readonly EffectIntent[] {
  if (ended.includes(event.type))
    return intents.filter((intent) => intent.runId !== event.runId);
  if (event.type === "run.started")
    return intents.filter(
      (intent) => intent.runId !== event.runId || intent.kind !== "start-run",
    );
  return intents;
}

function nextEffects(state: AuthorityState, change: Change): EffectState {
  const effects = change.effects ?? state.effects;
  return ended.includes(change.event.type)
    ? endedRun(effects, change.event)
    : effects;
}

function nextIntents(
  state: AuthorityState,
  change: Change,
): readonly EffectIntent[] {
  const released = change.released ?? [];
  return [
    ...retained(state.intents, change.event).filter(
      (intent) => !released.includes(intent.operationId),
    ),
    ...(change.added ?? []),
  ];
}

function nextDetails(change: Change): RunDetails {
  const details = change.observed ?? change.details;
  const continuation = (change.added ?? []).some(
    (intent) => intent.kind === "continue-run",
  );
  return continuation ? continued(details) : details;
}

export function applied(state: AuthorityState, change: Change): Applied {
  const { event } = change;
  const waits = change.commandWaits ?? state.commandWaits;
  return {
    kind: "applied",
    ...(change.disposition === undefined
      ? {}
      : { disposition: change.disposition }),
    state: {
      ...(waits === undefined
        ? {}
        : { commandWaits: closedCommandWaits(waits, event) }),
      sequence: event.sequence,
      runs: change.moved
        ? { ...state.runs, [event.runId]: change.moved }
        : state.runs,
      commands: change.commands,
      effects: nextEffects(state, change),
      intents: nextIntents(state, change),
      gates: {
        ...state.gates,
        ...Object.fromEntries(
          (change.gates ?? []).map((gate) => [
            gateKey(gate.runId, gate.gateId),
            gate,
          ]),
        ),
      },
      details: { ...state.details, [event.runId]: nextDetails(change) },
      questions: change.questions ?? state.questions,
    },
    intents: change.added ?? [],
  };
}
