import type { Database, JsonObject } from "solid-objects";
import {
  eligibleIntents,
  type AuthorityEvent,
  type EffectIntent,
} from "../../authority/reducer.ts";
import {
  loadProjections,
  type ProjectionSnapshot,
} from "../../storage/decision-snapshots.ts";
import { loadEvents } from "../../storage/domain-rows.ts";
import type {
  AdmissionResult,
  ExecutionManifest,
} from "../../workflow-admission.ts";
import { pinnedResumption } from "../authority-admission.ts";
import {
  currentState,
  intentKind,
  storedDefinitions,
  storedEvents,
  type StoredState,
} from "../authority-restore.ts";
import { checkedRequest } from "./authority-actor.ts";
import {
  subscriptions,
  type SequenceChanges,
  type SequenceListener,
} from "./authority-changes.ts";
import {
  authorityQueries,
  guardedRead,
  type AuthorityQueries,
} from "./authority-queries.ts";
import { effectQueries, type EffectQueries } from "./effect-queries.ts";
import { backupInto } from "../../storage/domain-schema.ts";
import {
  observeSettings,
  type ConnectionSettings,
} from "./authority-connection.ts";
import {
  failed,
  serializable,
  storeReceipt,
  invalidCommand,
  oversized,
  tooLarge,
  unserializable,
  type StoreReceipt,
} from "./authority-receipts.ts";

export type { StoreReceipt } from "./authority-receipts.ts";
export type { StoredState } from "../authority-restore.ts";

export interface CommandContext {
  readonly recordedAt: string;
  readonly manifest?: ExecutionManifest;
  readonly epoch?: number;
  readonly documents?: readonly string[];
}

export interface OperationRecord {
  readonly operationId: string;
  readonly kind: EffectIntent["kind"];
  readonly runId: string;
  readonly createdSequence: number;
  readonly releasedSequence: number | null;
  readonly deliveries: readonly {
    readonly effectId: string;
    readonly outcome: string | null;
    readonly receipt: string | null;
    readonly purpose: string;
    readonly epoch: number | null;
  }[];
}

export interface Authority {
  readonly execute: (
    command: unknown,
    context: CommandContext,
  ) => Promise<StoreReceipt>;
  readonly state: () => Promise<StoredState>;
  readonly events: () => Promise<readonly AuthorityEvent[]>;
  readonly eligibleIntents: () => Promise<readonly EffectIntent[]>;
  readonly operations: () => Promise<readonly OperationRecord[]>;
  readonly resumePinned: (
    runId: string,
    available: ExecutionManifest,
  ) => Promise<AdmissionResult>;
  readonly settings: () => Promise<ConnectionSettings>;
  readonly epoch: number;
  readonly recoveryLimit: number;
  readonly queries: AuthorityQueries;
  readonly effects: EffectQueries;
  readonly deliver: (signal: AbortSignal) => Promise<void>;
  readonly changes: SequenceChanges;
  readonly backup: (target: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface SessionParts {
  readonly database: Database;
  readonly reader: Database;
  readonly execute: (request: JsonObject) => Promise<unknown>;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly handlersSettled: () => Promise<boolean>;
  readonly deliveryConfigured: boolean;
  readonly epoch: number;
  readonly stopLimit: number;
  readonly recoveryLimit: number;
  readonly unhealthy: () => string | undefined;
  readonly condition: () => Promise<string | undefined>;
  readonly watchMilliseconds: number;
  readonly subscribe: (listener: SequenceListener) => () => void;
}

interface Session {
  readonly parts: SessionParts;
  readonly stopping: AbortController;
  delivering: boolean;
  failure: string | null;
  condition: string | null;
  describing: Promise<void> | null;
  closed: boolean;
  running: Promise<void>;
  readonly invocations: Set<Promise<unknown>>;
  readonly changes: ReturnType<typeof subscriptions>;
  closing: Promise<void> | null;
}

export function authoritySession(parts: SessionParts): Authority {
  const session: Session = {
    parts,
    stopping: new AbortController(),
    delivering: false,
    failure: null,
    condition: null,
    describing: null,
    closed: false,
    running: Promise.resolve(),
    invocations: new Set(),
    changes: subscriptions(parts.subscribe),
    closing: null,
  };
  const read = guardedRead({
    reader: parts.reader,
    ready: async () => {
      await refreshed(session);
      available(session);
    },
  });
  return {
    execute: (command, context) =>
      executeCommand(session, { command, context }),
    state: async () => currentState(await projected(session)),
    events: async () => {
      await refreshed(session);
      available(session);
      return storedEvents(await parts.reader.connection(loadEvents));
    },
    eligibleIntents: async () => eligible(await projected(session)),
    operations: async () => operationRecords(await projected(session)),
    resumePinned: async (runId, manifest) => {
      const snapshot = await projected(session);
      return pinnedResumption(currentState(snapshot), {
        definitions: storedDefinitions(snapshot),
        runId,
        available: manifest,
      });
    },
    settings: async () => {
      await refreshed(session);
      available(session);
      return observeSettings(parts.database);
    },
    epoch: parts.epoch,
    recoveryLimit: parts.recoveryLimit,
    queries: authorityQueries(read),
    effects: effectQueries(read, { stopLimit: parts.stopLimit }),
    deliver: (signal) => deliver(session, signal),
    changes: { subscribe: session.changes.add },
    backup: (target) => backup(session, target),
    close: () => close(session),
  };
}

function close(session: Session): Promise<void> {
  session.closed = true;
  session.closing ??= stopped(session);
  return session.closing;
}

async function stopped(session: Session): Promise<void> {
  try {
    session.stopping.abort();
    session.changes.close();
    await Promise.allSettled([session.running, ...session.invocations]);
    await session.parts.stop();
  } catch (error) {
    session.closing = null;
    throw error;
  }
}

async function refreshed(session: Session): Promise<void> {
  if (session.parts.unhealthy() === undefined) return;
  await failClosed(session, "authority failure");
}

async function failClosed(session: Session, failure: string): Promise<void> {
  session.failure ??= failure;
  await conditionRead(session);
  close(session).catch(() => undefined);
}

async function conditionRead(session: Session): Promise<void> {
  if (session.condition !== null && session.describing === null) return;
  session.describing ??= described(session).finally(() => {
    session.describing = null;
  });
  await session.describing;
}

async function described(session: Session): Promise<void> {
  const detected = session.parts.unhealthy();
  if (detected === undefined) return;
  session.condition = detected;
  session.condition = (await session.parts.condition()) ?? detected;
}

async function backup(session: Session, target: string): Promise<void> {
  await refreshed(session);
  available(session);
  try {
    await session.parts.database.connection((connection) =>
      backupInto(connection, target),
    );
  } catch (error) {
    throw new Error(
      `backup-failed: ${String(Reflect.get(Object(error), "message"))}`,
      { cause: error },
    );
  }
}

function available(session: Session): void {
  const failure = session.condition ?? session.failure;
  if (failure !== null) throw new Error(`authority-unavailable: ${failure}`);
  if (session.closed) throw new Error("authority-unavailable: closed");
}

function unavailableReceipt(session: Session): StoreReceipt | undefined {
  const failure = session.condition ?? session.failure;
  if (failure !== null)
    return {
      kind: "failed",
      reason: "storage-unavailable",
      detail: `closed after ${failure}`,
    };
  if (session.closed)
    return { kind: "failed", reason: "storage-unavailable", detail: "closed" };
  return undefined;
}

async function projected(session: Session): Promise<ProjectionSnapshot> {
  await refreshed(session);
  available(session);
  return session.parts.reader.connection(loadProjections);
}

async function deliver(session: Session, signal: AbortSignal): Promise<void> {
  if (!session.parts.deliveryConfigured)
    throw new Error("delivery-unconfigured");
  if (session.delivering) throw new Error("delivery-already-running");
  available(session);
  session.delivering = true;
  try {
    await delivered(session, signal);
  } finally {
    session.delivering = false;
  }
  await refreshed(session);
  const failure = session.condition ?? session.failure;
  if (failure !== null) throw new Error(`authority-unavailable: ${failure}`);
}

async function delivered(session: Session, signal: AbortSignal): Promise<void> {
  if (!(await session.parts.handlersSettled()))
    throw new Error("delivery-handler-in-flight");
  available(session);
  const watch = new AbortController();
  const timer = setInterval(() => {
    if (session.parts.unhealthy() !== undefined) watch.abort();
  }, session.parts.watchMilliseconds);
  try {
    session.running = session.parts.run(
      AbortSignal.any([signal, session.stopping.signal, watch.signal]),
    );
    await session.running;
  } finally {
    clearInterval(timer);
  }
}

async function executeCommand(
  session: Session,
  input: { readonly command: unknown; readonly context: CommandContext },
): Promise<StoreReceipt> {
  const { command, context } = input;
  await refreshed(session);
  const unavailable = unavailableReceipt(session);
  if (unavailable !== undefined) return unavailable;
  const given = serializable({
    command,
    recordedAt: context.recordedAt,
    manifest: context.manifest ?? null,
    epoch: context.epoch ?? null,
    documents: context.documents ?? [],
  });
  if (given === undefined) return unserializable;
  const request = checkedRequest(given);
  if (request === undefined) return invalidCommand;
  if (oversized(request)) return tooLarge;
  try {
    return await healthyReceipt(session, await invoked(session, request));
  } catch (error) {
    const receipt = failed(error);
    await failClosed(
      session,
      receipt.reason === "storage-failure"
        ? "storage failure"
        : "authority failure",
    );
    return receipt;
  }
}

async function invoked(
  session: Session,
  request: JsonObject,
): Promise<unknown> {
  const invocation = session.parts.execute(request);
  session.invocations.add(invocation);
  try {
    return await invocation;
  } finally {
    session.invocations.delete(invocation);
  }
}

async function healthyReceipt(
  session: Session,
  value: unknown,
): Promise<StoreReceipt> {
  const receipt = storeReceipt(value);
  await refreshed(session);
  return receipt;
}

function operationRecords(
  snapshot: Pick<ProjectionSnapshot, "outbox" | "deliveries">,
): readonly OperationRecord[] {
  return snapshot.outbox.map((row) => ({
    operationId: row.operationId,
    kind: intentKind(row.kind),
    runId: row.runId,
    createdSequence: row.createdSequence,
    releasedSequence: row.releasedSequence,
    deliveries: snapshot.deliveries
      .filter((delivery) => delivery.operationId === row.operationId)
      .map(({ effectId, outcome, receipt, purpose, epoch }) => ({
        effectId,
        outcome,
        receipt,
        purpose,
        epoch,
      })),
  }));
}

function eligible(snapshot: ProjectionSnapshot): readonly EffectIntent[] {
  return eligibleIntents({
    ...currentState(snapshot),
    effects: {
      operations: Object.fromEntries(
        snapshot.pending.map((operationId) => [
          operationId,
          { status: "dispatch-pending" },
        ]),
      ),
    },
  });
}
