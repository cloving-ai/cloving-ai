import type {
  AuthorityCommand,
  AuthorityEvent,
  AuthorityState,
  EffectIntent,
} from "./transitions.ts";
import { operationIdentity } from "../operation-identity.ts";
import { commandEvents, parseCommand } from "./commands.ts";
import { parseEvent } from "./events.ts";
import { transition } from "./transitions.ts";

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
    }
  | { readonly kind: "duplicate"; readonly sequence: number }
  | { readonly kind: "rejected"; readonly reason: string };

type Reduction =
  | {
      readonly kind: "applied";
      readonly state: AuthorityState;
      readonly intents: readonly EffectIntent[];
    }
  | { readonly kind: "invalid"; readonly reason: string };

export const emptyAuthority: AuthorityState = {
  sequence: 0,
  runs: {},
  commands: {},
  intents: [],
};

export function execute(
  state: AuthorityState,
  proposed: unknown,
  recorded: { readonly recordedAt: string },
): CommandResult {
  const command = parseCommand(proposed);
  if (!command) return { kind: "rejected", reason: "invalid-command" };
  const request = canonical(command);
  const existing = state.commands[command.commandId];
  if (existing)
    return existing.request === request
      ? { kind: "duplicate", sequence: existing.sequence }
      : { kind: "rejected", reason: "conflicting-command" };
  const run = state.runs[command.runId];
  if (
    run &&
    command.expectedRevision !== undefined &&
    command.expectedRevision !== run.revision
  )
    return { kind: "rejected", reason: "stale-revision" };
  const event = commandEvent(state, command, request, recorded.recordedAt);
  const reduction = reduce(state, event);
  if (reduction.kind === "invalid")
    return { kind: "rejected", reason: reduction.reason };
  return {
    kind: "accepted",
    events: [event],
    state: reduction.state,
    intents: reduction.intents,
  };
}

export function rebuild(events: readonly unknown[]): AuthorityState {
  let state = emptyAuthority;
  for (const [index, value] of events.entries()) {
    const event = parseEvent(value);
    if (!event)
      throw new Error(`invalid-event: ${String(index + 1)} malformed-event`);
    const reduction = reduce(state, event);
    if (reduction.kind === "invalid")
      throw new Error(
        `invalid-event: ${String(event.sequence)} ${reduction.reason}`,
      );
    state = reduction.state;
  }
  return state;
}

function commandEvent(
  state: AuthorityState,
  command: AuthorityCommand,
  request: string,
  recordedAt: string,
): AuthorityEvent {
  const payload: Record<string, string> = {};
  if (command.workflow !== undefined) payload["workflow"] = command.workflow;
  if (command.gateId !== undefined) payload["gateId"] = command.gateId;
  if (command.decision !== undefined) payload["decision"] = command.decision;
  return {
    sequence: state.sequence + 1,
    type: commandEvents[command.kind] ?? "run.created",
    runId: command.runId,
    commandId: command.commandId,
    recordedAt,
    request,
    payload,
  };
}

function reduce(state: AuthorityState, event: AuthorityEvent): Reduction {
  if (event.sequence !== state.sequence + 1)
    return { kind: "invalid", reason: "sequence-gap" };
  if (state.commands[event.commandId])
    return { kind: "invalid", reason: "duplicate-command" };
  const commands = {
    ...state.commands,
    [event.commandId]: { request: event.request, sequence: event.sequence },
  };
  if (event.type === "run.created") return created(state, event, commands);
  const run = state.runs[event.runId];
  if (!run) return { kind: "invalid", reason: "unknown-run" };
  const moved = transition(run, event.type, event.payload["gateId"] ?? "");
  if (moved.kind === "invalid") return moved;
  const released = [
    "run.started",
    "run.cancelled",
    "run.failed",
    "run.completed",
  ].includes(event.type);
  return {
    kind: "applied",
    state: {
      sequence: event.sequence,
      runs: { ...state.runs, [event.runId]: moved.run },
      commands,
      intents: released
        ? state.intents.filter((intent) => intent.runId !== event.runId)
        : state.intents,
    },
    intents: [],
  };
}

function created(
  state: AuthorityState,
  event: AuthorityEvent,
  commands: AuthorityState["commands"],
): Reduction {
  if (state.runs[event.runId])
    return { kind: "invalid", reason: "existing-run" };
  const intent: EffectIntent = {
    kind: "start-run",
    runId: event.runId,
    operationId: startOperation(event.runId),
  };
  return {
    kind: "applied",
    state: {
      sequence: event.sequence,
      runs: {
        ...state.runs,
        [event.runId]: {
          runId: event.runId,
          status: "queued",
          revision: 1,
          workflow: event.payload["workflow"] ?? "",
          pausedFrom: null,
          gates: [],
        },
      },
      commands,
      intents: [...state.intents, intent],
    },
    intents: [intent],
  };
}

function startOperation(runId: string): string {
  const identity = operationIdentity({
    run: runId,
    phase: "admission",
    round: 0,
    operation: "start-run",
  });
  return identity.kind === "valid" ? identity.value : "";
}

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

export function eligibleIntents(
  state: AuthorityState,
): readonly EffectIntent[] {
  return state.intents.filter(
    (intent) => state.runs[intent.runId]?.status === "queued",
  );
}
