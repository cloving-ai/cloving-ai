import type { CommandWaitRow } from "../storage/command-wait-rows.ts";
import {
  commandWaitState,
  commandWaitRows,
  commandOutputsIntact,
} from "./command-wait-restore.ts";
import { isDeepStrictEqual } from "node:util";
import { parseEvent } from "../authority/events.ts";
import { rebuildHistory, type History } from "../authority/history.ts";
import type {
  AuthorityEvent,
  AuthorityState,
  EffectIntent,
  RunState,
  RunStatus,
} from "../authority/reducer.ts";
import { readExecutionManifest } from "../execution-pin.ts";
import type { DecisionRows, DocumentRow } from "../storage/decision-rows.ts";
import type { EffectRows } from "../storage/effect-rows.ts";
import type { ProjectionSnapshot } from "../storage/decision-snapshots.ts";
import type { AuthoritySnapshot, EventRow } from "../storage/domain-rows.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";
import {
  decisionRows,
  decisionState,
  documentsIntact,
  referencedDigests,
} from "./decision-restore.ts";
import { effectChecks, effectDigests } from "./effect-restore.ts";
import { workflowPin } from "./workflow-pin.ts";

export type RestoredSnapshot = AuthoritySnapshot &
  Partial<DecisionRows> & {
    readonly documents?: readonly DocumentRow[];
    readonly effects?: EffectRows;
    readonly waits?: readonly CommandWaitRow[];
  };

const statuses: readonly RunStatus[] = [
  "queued",
  "running",
  "waiting_gate",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

export type Restoration =
  | {
      readonly kind: "restored";
      readonly state: AuthorityState;
      readonly events: readonly AuthorityEvent[];
      readonly definitions: ReadonlyMap<string, ExecutionManifest>;
    }
  | {
      readonly kind: "refused";
      readonly reason: "invalid-history" | "projection-mismatch";
      readonly detail: string;
    };

export function restore(snapshot: RestoredSnapshot): Restoration {
  let events: readonly AuthorityEvent[];
  let history: History;
  try {
    events = storedEvents(snapshot.events);
    history = rebuildHistory(events);
  } catch (error) {
    return { kind: "refused", reason: "invalid-history", detail: text(error) };
  }
  let stored: AuthorityState;
  try {
    stored = {
      ...history.state,
      ...projectedState({
        ...snapshot,
        sequence: snapshot.events.at(-1)?.sequence ?? 0,
      }),
    };
  } catch (error) {
    return {
      kind: "refused",
      reason: "projection-mismatch",
      detail: text(error),
    };
  }
  const { state } = history;
  const definitions = storedDefinitions(snapshot);
  const checks: readonly (readonly [string, boolean])[] = [
    ...projectionParts.map(
      (part) => [part, isDeepStrictEqual(stored[part], state[part])] as const,
    ),
    ["outbox", isDeepStrictEqual(snapshot.outbox, history.outbox)],
    [
      "run-sequences",
      isDeepStrictEqual(
        Object.fromEntries(
          snapshot.runs.map((row) => [row.runId, row.sequence]),
        ),
        history.runSequences,
      ),
    ],
    ["definitions", definitionsIntact(definitions, state)],
    ...waitChecks(snapshot, { state, definitions, events }),
    ...decisionChecks(snapshot, state),
    ...(snapshot.effects === undefined
      ? []
      : effectChecks(snapshot.effects, {
          effects: state.effects,
          evidence: history.evidence,
        })),
  ];
  const failed = checks.find(([, holds]) => !holds);
  if (failed)
    return {
      kind: "refused",
      reason: "projection-mismatch",
      detail: failed[0],
    };
  return { kind: "restored", state, events, definitions };
}

function waitChecks(
  snapshot: RestoredSnapshot,
  context: {
    readonly state: AuthorityState;
    readonly events: readonly AuthorityEvent[];
    readonly definitions: ReadonlyMap<string, ExecutionManifest>;
  },
): readonly (readonly [string, boolean])[] {
  const { state, definitions } = context;
  return [
    ["command-outputs", commandOutputsIntact(context.events)],
    ["command-waits", commandWaitsIntact(definitions, state)],
    ...(snapshot.waits === undefined
      ? []
      : [
          [
            "waits",
            isDeepStrictEqual(
              snapshot.waits,
              commandWaitRows(state.commandWaits ?? {}),
            ),
          ] as const,
        ]),
  ];
}

function decisionChecks(
  snapshot: RestoredSnapshot,
  state: AuthorityState,
): readonly (readonly [string, boolean])[] {
  const { gates, details, documents } = snapshot;
  if (gates === undefined || details === undefined || documents === undefined)
    return [];
  const expected = decisionRows(state);
  return [
    ["gates", isDeepStrictEqual(gates, expected.gates)],
    ["details", isDeepStrictEqual(details, expected.details)],
    [
      "documents",
      documentsIntact(documents, [
        ...referencedDigests(state),
        ...effectDigests(state.effects),
      ]),
    ],
  ];
}

export function storedDefinitions(
  snapshot: Pick<ProjectionSnapshot, "definitions">,
): ReadonlyMap<string, ExecutionManifest> {
  return new Map(
    snapshot.definitions.map((row) => [
      row.pin,
      readExecutionManifest(parsed(row.manifest)),
    ]),
  );
}

function definitionsIntact(
  definitions: ReadonlyMap<string, ExecutionManifest>,
  state: AuthorityState,
): boolean {
  const used = new Set(Object.values(state.runs).map((run) => run.workflow));
  return (
    [...definitions].every(
      ([pin, manifest]) => workflowPin(manifest) === pin && used.has(pin),
    ) && [...used].every((pin) => definitions.has(pin))
  );
}

function commandWaitsIntact(
  definitions: ReadonlyMap<string, ExecutionManifest>,
  state: AuthorityState,
): boolean {
  return Object.values(state.commandWaits ?? {}).every((wait) => {
    const pin = state.runs[wait.runId]?.workflow ?? "";
    const waits = definitions.get(pin)?.commandWaits ?? {};
    const permission = Object.hasOwn(waits, wait.name)
      ? waits[wait.name]
      : undefined;
    return (
      permission !== undefined &&
      permission.command === wait.command &&
      permission.maximumWaitSeconds === wait.maximumWaitSeconds &&
      permission.pollEverySeconds === wait.pollEverySeconds
    );
  });
}

const projectionParts = ["sequence", "runs", "commands", "intents"] as const;

function text(error: unknown): string {
  return String(Reflect.get(Object(error), "message"));
}

type BaseState = Pick<
  AuthorityState,
  "sequence" | "runs" | "commands" | "intents"
>;

export type StoredState = Omit<AuthorityState, "effects">;

export function currentState(snapshot: ProjectionSnapshot): StoredState {
  return {
    ...projectedState(snapshot),
    ...decisionState(snapshot),
    ...commandWaitState(snapshot.waits ?? []),
  };
}

export function projectedState(
  snapshot: Pick<
    ProjectionSnapshot,
    "runs" | "commands" | "outbox" | "sequence"
  >,
): BaseState {
  return {
    sequence: snapshot.sequence,
    runs: Object.fromEntries(
      snapshot.runs.map((row) => [row.runId, storedRun(row)]),
    ),
    commands: Object.fromEntries(
      snapshot.commands.map((row) => [
        row.commandId,
        { request: row.request, sequence: row.sequence },
      ]),
    ),
    intents: snapshot.outbox
      .filter((row) => row.releasedSequence === null)
      .map((row) => ({
        kind: intentKind(row.kind),
        runId: row.runId,
        operationId: row.operationId,
      })),
  };
}

const intentKinds: readonly EffectIntent["kind"][] = [
  "start-run",
  "continue-run",
  "resume-hook",
  "protected-effect",
];

export function intentKind(value: string): EffectIntent["kind"] {
  const kind = intentKinds.find((candidate) => candidate === value);
  if (!kind) throw new Error("invalid-outbox-row");
  return kind;
}

export function storedRun(row: AuthoritySnapshot["runs"][number]): RunState {
  const status = statuses.find((candidate) => candidate === row.status);
  const pausedFrom = statuses.find((candidate) => candidate === row.pausedFrom);
  const gates: unknown = JSON.parse(row.gates);
  const unknownPause = row.pausedFrom !== null && pausedFrom === undefined;
  if (!status || unknownPause || !Array.isArray(gates))
    throw new Error("invalid-run-row");
  return {
    runId: row.runId,
    status,
    revision: row.revision,
    workflow: row.workflow,
    pausedFrom: pausedFrom ?? null,
    gates: gates.map(String),
  };
}

export function storedEvents(
  rows: readonly EventRow[],
): readonly AuthorityEvent[] {
  return rows.map(storedEvent);
}

function storedEvent(row: EventRow): AuthorityEvent {
  const event = parseEvent({ ...row, payload: parsed(row.payload) });
  if (!event) throw new Error(`invalid-event-row: ${String(row.sequence)}`);
  return event;
}

function parsed(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
