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
import type { AuthoritySnapshot } from "../storage/authority-database.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";
import { workflowPin } from "./workflow-pin.ts";

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

export function restore(snapshot: AuthoritySnapshot): Restoration {
  let events: readonly AuthorityEvent[];
  let history: History;
  try {
    events = snapshot.events.map(storedEvent);
    history = rebuildHistory(events);
  } catch (error) {
    return { kind: "refused", reason: "invalid-history", detail: text(error) };
  }
  let stored: AuthorityState;
  try {
    stored = projection(snapshot);
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

function storedDefinitions(
  snapshot: AuthoritySnapshot,
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

const projectionParts = ["sequence", "runs", "commands", "intents"] as const;

function text(error: unknown): string {
  return String(Reflect.get(Object(error), "message"));
}

function projection(snapshot: AuthoritySnapshot): AuthorityState {
  return {
    sequence: snapshot.events.at(-1)?.sequence ?? 0,
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
];

function intentKind(value: string): EffectIntent["kind"] {
  const kind = intentKinds.find((candidate) => candidate === value);
  if (!kind) throw new Error("invalid-outbox-row");
  return kind;
}

function storedRun(row: AuthoritySnapshot["runs"][number]): RunState {
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

function storedEvent(row: AuthoritySnapshot["events"][number]): AuthorityEvent {
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
