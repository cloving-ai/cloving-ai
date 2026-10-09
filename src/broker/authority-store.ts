import { join } from "node:path";
import {
  eligibleIntents,
  execute,
  type AuthorityEvent,
  type AuthorityState,
  type CommandResult,
  type EffectIntent,
} from "../authority/reducer.ts";
import {
  openAuthorityDatabase,
  type AuthorityChange,
  type AuthorityDatabase,
  type AuthoritySnapshot,
  type CommitOutcome,
  type ConnectionSettings,
  type DatabaseOpening,
} from "../storage/authority-database.ts";
import type {
  AdmissionResult,
  ExecutionManifest,
} from "../workflow-admission.ts";
import { admitted, pinnedResumption } from "./authority-admission.ts";
import { restore, type Restoration } from "./authority-restore.ts";

export type StoreReceipt =
  | {
      readonly kind: "accepted";
      readonly sequence: number;
      readonly intents: readonly EffectIntent[];
    }
  | { readonly kind: "duplicate"; readonly sequence: number }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly detail?: string;
    }
  | Extract<CommitOutcome, { kind: "failed" }>;

export interface CommandContext {
  readonly recordedAt: string;
  readonly manifest?: ExecutionManifest;
}

export interface AuthorityStore {
  readonly execute: (command: unknown, context: CommandContext) => StoreReceipt;
  readonly state: () => AuthorityState;
  readonly events: () => readonly AuthorityEvent[];
  readonly eligibleIntents: () => readonly EffectIntent[];
  readonly settings: () => ConnectionSettings;
  readonly resumePinned: (
    runId: string,
    available: ExecutionManifest,
  ) => AdmissionResult;
  readonly close: () => void;
}

export type StoreOpening =
  | { readonly kind: "opened"; readonly store: AuthorityStore }
  | Extract<DatabaseOpening, { kind: "refused" }>
  | Extract<Restoration, { kind: "refused" }>;

export function openAuthorityStore(directory: string): StoreOpening {
  const opening = openAuthorityDatabase(join(directory, "authority.sqlite"));
  if (opening.kind === "refused") return opening;
  const { database } = opening;
  let snapshot: AuthoritySnapshot;
  try {
    snapshot = database.load();
  } catch (error) {
    database.close();
    return {
      kind: "refused",
      reason: "storage-failure",
      detail: String(Reflect.get(Object(error), "message")),
    };
  }
  const restored = restore(snapshot);
  if (restored.kind === "refused") {
    database.close();
    return restored;
  }
  return { kind: "opened", store: authorityStore(database, restored) };
}

function authorityStore(
  database: AuthorityDatabase,
  initial: Extract<Restoration, { kind: "restored" }>,
): AuthorityStore {
  let state = initial.state;
  let events = initial.events;
  const definitions = new Map(initial.definitions);
  return {
    execute: (command, context) => {
      const admission = admitted(state, definitions, command, context.manifest);
      if (admission.kind === "rejected") return admission;
      const result = execute(state, command, context);
      if (result.kind !== "accepted") return result;
      const outcome = database.commit(
        change(state, result, admission.definitions),
      );
      if (outcome.kind === "failed") return outcome;
      state = result.state;
      events = [...events, ...result.events];
      for (const [pin, manifest] of admission.definitions)
        if (!definitions.has(pin)) definitions.set(pin, manifest);
      return {
        kind: "accepted",
        sequence: state.sequence,
        intents: result.intents,
      };
    },
    state: () => state,
    events: () => events,
    eligibleIntents: () => eligibleIntents(state),
    settings: database.settings,
    resumePinned: (runId, available) =>
      pinnedResumption(state, definitions, runId, available),
    close: () => {
      database.close();
    },
  };
}

function change(
  before: AuthorityState,
  result: Extract<CommandResult, { kind: "accepted" }>,
  definitions: ReadonlyMap<string, ExecutionManifest>,
): AuthorityChange {
  const { state, events } = result;
  const touched = new Set(events.map((event) => event.runId));
  const retained = new Set(state.intents.map((intent) => intent.operationId));
  return {
    sequence: state.sequence,
    definitions: [...definitions].map(([pin, manifest]) => ({
      pin,
      manifest: JSON.stringify(manifest),
    })),
    events: events.map((event) => ({
      ...event,
      payload: JSON.stringify(event.payload),
    })),
    runs: Object.values(state.runs)
      .filter((run) => touched.has(run.runId))
      .map((run) => ({
        ...run,
        gates: JSON.stringify(run.gates),
        sequence: state.sequence,
      })),
    commands: events.map((event) => ({
      commandId: event.commandId,
      request: event.request,
      sequence: event.sequence,
    })),
    added: result.intents.map((intent) => ({
      ...intent,
      createdSequence: state.sequence,
    })),
    released: before.intents
      .map((intent) => intent.operationId)
      .filter((operationId) => !retained.has(operationId)),
  };
}
