import {
  numberFields,
  textFields,
  type AuthorityCommand,
  type AuthorityEvent,
  type AuthorityState,
  type EffectIntent,
} from "./transitions.ts";
import { commandEvents, parseCommand } from "./commands.ts";
import { parseEvent } from "./events.ts";
import { gateKey } from "./gates.ts";
import {
  emptyEffects,
  evidenceOf,
  type Disposition,
  type Evidence,
} from "./operations.ts";
import { reduce } from "./reduction.ts";

export type {
  AuthorityEvent,
  AuthorityState,
  EffectIntent,
  RunState,
  RunStatus,
} from "./transitions.ts";

export type CommandResult =
  | {
      readonly kind: "accepted";
      readonly events: readonly AuthorityEvent[];
      readonly state: AuthorityState;
      readonly intents: readonly EffectIntent[];
      readonly disposition?: Disposition;
    }
  | { readonly kind: "duplicate"; readonly sequence: number }
  | { readonly kind: "rejected"; readonly reason: string };

export const emptyAuthority: AuthorityState = {
  sequence: 0,
  runs: {},
  commands: {},
  intents: [],
  gates: {},
  details: {},
  questions: 0,
  effects: emptyEffects,
};

export function execute(
  state: AuthorityState,
  proposed: { readonly command: unknown; readonly recordedAt: string },
): CommandResult {
  const command = parseCommand(proposed.command);
  if (!command) return { kind: "rejected", reason: "invalid-command" };
  const request = canonical(command);
  const existing = state.commands[command.commandId];
  if (existing)
    return existing.request === request
      ? { kind: "duplicate", sequence: existing.sequence }
      : { kind: "rejected", reason: "conflicting-command" };
  if (staleRevision(state, command))
    return { kind: "rejected", reason: "stale-revision" };
  const event = commandEvent(command, {
    sequence: state.sequence + 1,
    request,
    recordedAt: proposed.recordedAt,
  });
  const reduction = reduce(state, event);
  if (reduction.kind === "invalid")
    return { kind: "rejected", reason: reduction.reason };
  return {
    kind: "accepted",
    events: [event],
    state: reduction.state,
    intents: reduction.intents,
    ...(reduction.disposition === undefined
      ? {}
      : { disposition: reduction.disposition }),
  };
}

export function rebuild(events: readonly unknown[]): AuthorityState {
  let state = emptyAuthority;
  for (const [index, value] of events.entries())
    state = applyEvent(state, { value, index }).state;
  return state;
}

export function applyEvent(
  state: AuthorityState,
  entry: { readonly value: unknown; readonly index: number },
): {
  readonly state: AuthorityState;
  readonly event: AuthorityEvent;
  readonly evidence: readonly Evidence[];
} {
  const { value, index } = entry;
  const event = parseEvent(value);
  if (!event)
    throw new Error(`invalid-event: ${String(index + 1)} malformed-event`);
  if (!requestMatches(event))
    throw new Error(`invalid-event: ${String(index + 1)} request-mismatch`);
  const reduction = reduce(state, event);
  if (reduction.kind === "invalid")
    throw new Error(
      `invalid-event: ${String(event.sequence)} ${reduction.reason}`,
    );
  return {
    state: reduction.state,
    event,
    evidence: evidenceOf(event, reduction.disposition),
  };
}

function commandEvent(
  command: AuthorityCommand,
  record: {
    readonly sequence: number;
    readonly request: string;
    readonly recordedAt: string;
  },
): AuthorityEvent {
  const { sequence, request, recordedAt } = record;
  const payload: Record<string, string> = {};
  for (const name of payloadFields) {
    const value = command[name];
    if (value !== undefined) payload[name] = String(value);
  }
  return {
    sequence,
    type: commandEvents[command.kind] ?? "run.created",
    runId: command.runId,
    commandId: command.commandId,
    recordedAt,
    request,
    payload,
  };
}

function staleRevision(
  state: AuthorityState,
  command: AuthorityCommand,
): boolean {
  const run = state.runs[command.runId];
  if (!run || command.expectedRevision === undefined) return false;
  const gate =
    command.kind === "decide-gate"
      ? state.gates[gateKey(command.runId, command.gateId ?? "")]
      : undefined;
  if (gate === undefined || gate.kind === "untyped")
    return command.expectedRevision !== run.revision;
  return gate.outcome === null && command.expectedRevision !== gate.revision;
}

const payloadFields = [
  ...textFields,
  ...numberFields.filter((name) => name !== "expectedRevision"),
];

function canonical(value: AuthorityCommand): string {
  const fields: Readonly<Record<string, unknown>> = value;
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(fields)
        .sort()
        .map((key) => [key, fields[key]]),
    ),
  );
}

type Statuses = Readonly<Record<string, { readonly status: string }>>;

export interface Eligibility {
  readonly intents: readonly EffectIntent[];
  readonly runs: Statuses;
  readonly effects: { readonly operations: Statuses };
}

export function eligibleIntents(state: Eligibility): readonly EffectIntent[] {
  return state.intents.filter((intent) => eligible(state, intent));
}

function eligible(state: Eligibility, intent: EffectIntent): boolean {
  if (intent.kind === "protected-effect")
    return (
      state.effects.operations[intent.operationId]?.status ===
      "dispatch-pending"
    );
  return (
    state.runs[intent.runId]?.status ===
    (intent.kind === "start-run" ? "queued" : "running")
  );
}

function requestMatches(event: AuthorityEvent): boolean {
  let value: unknown;
  try {
    value = JSON.parse(event.request);
  } catch {
    return false;
  }
  const command = parseCommand(value);
  if (!command || canonical(command) !== event.request) return false;
  const expected = commandEvent(command, event);
  return JSON.stringify(sorted(expected)) === JSON.stringify(sorted(event));
}

function sorted(event: AuthorityEvent): readonly unknown[] {
  return [
    event.type,
    event.runId,
    event.commandId,
    Object.entries(event.payload).sort(([left], [right]) =>
      left < right ? -1 : 1,
    ),
  ];
}
