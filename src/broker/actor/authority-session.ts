import type { Database, JsonObject } from "solid-objects";
import {
  eligibleIntents,
  type AuthorityEvent,
  type AuthorityState,
  type EffectIntent,
} from "../../authority/reducer.ts";
import {
  integer,
  loadEvents,
  loadProjections,
  text,
  type ProjectionSnapshot,
} from "../../storage/domain-rows.ts";
import type {
  AdmissionResult,
  ExecutionManifest,
} from "../../workflow-admission.ts";
import { pinnedResumption } from "../authority-admission.ts";
import {
  intentKind,
  projectedState,
  storedDefinitions,
  storedEvents,
} from "../authority-restore.ts";
import { backupInto } from "../../storage/domain-schema.ts";
import {
  observeSettings,
  type ConnectionSettings,
} from "./authority-connection.ts";

export interface CommandContext {
  readonly recordedAt: string;
  readonly manifest?: ExecutionManifest;
  readonly epoch?: number;
}

export type StoreReceipt =
  | {
      readonly kind: "accepted" | "duplicate";
      readonly sequence: number;
      readonly intents: readonly EffectIntent[];
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "failed";
      readonly reason:
        "storage-failure" | "storage-unavailable" | "authority-unavailable";
      readonly detail: string;
    };

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
  }[];
}

export interface Authority {
  readonly execute: (
    command: unknown,
    context: CommandContext,
  ) => Promise<StoreReceipt>;
  readonly state: () => Promise<AuthorityState>;
  readonly events: () => Promise<readonly AuthorityEvent[]>;
  readonly eligibleIntents: () => Promise<readonly EffectIntent[]>;
  readonly operations: () => Promise<readonly OperationRecord[]>;
  readonly resumePinned: (
    runId: string,
    available: ExecutionManifest,
  ) => Promise<AdmissionResult>;
  readonly settings: () => Promise<ConnectionSettings>;
  readonly epoch: number;
  readonly deliver: (signal: AbortSignal) => Promise<void>;
  readonly backup: (target: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface SessionParts {
  readonly database: Database;
  readonly reader: Database;
  readonly execute: (request: JsonObject) => Promise<unknown>;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly deliveriesInFlight: () => number;
  readonly deliveryConfigured: boolean;
  readonly epoch: number;
  readonly unhealthy: () => string | undefined;
  readonly condition: () => Promise<string | undefined>;
  readonly watchMilliseconds: number;
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
    closing: null,
  };
  return {
    execute: (command, context) =>
      executeCommand(session, { command, context }),
    state: async () => projectedState(await projected(session)),
    events: async () => {
      available(session);
      return storedEvents(await parts.reader.connection(loadEvents));
    },
    eligibleIntents: async () =>
      eligibleIntents(projectedState(await projected(session))),
    operations: async () => operationRecords(await projected(session)),
    resumePinned: async (runId, manifest) => {
      const snapshot = await projected(session);
      return pinnedResumption(
        projectedState(snapshot),
        storedDefinitions(snapshot),
        runId,
        manifest,
      );
    },
    settings: async () => {
      available(session);
      return observeSettings(parts.database);
    },
    epoch: parts.epoch,
    deliver: (signal) => deliver(session, signal),
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
    await Promise.allSettled([session.running, ...session.invocations]);
    await session.parts.stop();
  } catch (error) {
    session.closing = null;
    throw error;
  }
}

async function failClosed(session: Session, failure: string): Promise<void> {
  session.failure ??= failure;
  session.describing ??= described(session);
  await session.describing;
  close(session).catch(() => undefined);
}

async function described(session: Session): Promise<void> {
  const detected = session.parts.unhealthy();
  if (detected === undefined) return;
  session.condition = detected;
  session.condition = (await session.parts.condition()) ?? detected;
}

async function backup(session: Session, target: string): Promise<void> {
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
  available(session);
  return session.parts.reader.connection(loadProjections);
}

async function deliver(session: Session, signal: AbortSignal): Promise<void> {
  if (!session.parts.deliveryConfigured)
    throw new Error("delivery-unconfigured");
  if (session.delivering) throw new Error("delivery-already-running");
  available(session);
  if (session.parts.deliveriesInFlight() > 0)
    throw new Error("delivery-handler-in-flight");
  session.delivering = true;
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
    session.delivering = false;
  }
  if (session.parts.unhealthy() !== undefined)
    await failClosed(session, "authority failure");
  const failure = session.condition ?? session.failure;
  if (failure !== null) throw new Error(`authority-unavailable: ${failure}`);
}

async function executeCommand(
  session: Session,
  input: { readonly command: unknown; readonly context: CommandContext },
): Promise<StoreReceipt> {
  const { command, context } = input;
  if (session.parts.unhealthy() !== undefined)
    await failClosed(session, "authority failure");
  const unavailable = unavailableReceipt(session);
  if (unavailable !== undefined) return unavailable;
  try {
    return await healthyReceipt(
      session,
      await invoked(
        session,
        json({
          command,
          recordedAt: context.recordedAt,
          manifest: context.manifest ?? null,
          epoch: context.epoch ?? null,
        }),
      ),
    );
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
  if (session.parts.unhealthy() !== undefined)
    await failClosed(session, "authority failure");
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
      .map(({ effectId, outcome, receipt }) => ({
        effectId,
        outcome,
        receipt,
      })),
  }));
}

function failed(error: unknown): Extract<StoreReceipt, { kind: "failed" }> {
  const name = String(Reflect.get(Object(error), "name"));
  if (name === "MessageFailed")
    return {
      kind: "failed",
      reason: "storage-failure",
      detail: String(
        Reflect.get(Object(Reflect.get(Object(error), "details")), "message"),
      ),
    };
  return {
    kind: "failed",
    reason: "authority-unavailable",
    detail: `${name}: ${String(Reflect.get(Object(error), "message"))}`,
  };
}

export function storeReceipt(value: unknown): StoreReceipt {
  const kind = text(value, "kind");
  if (kind === "rejected") {
    const detail: unknown = Reflect.get(Object(value), "detail");
    return {
      kind,
      reason: text(value, "reason"),
      ...(typeof detail === "string" ? { detail } : {}),
    };
  }
  if (kind !== "accepted" && kind !== "duplicate")
    throw new Error(`invalid-receipt: ${kind}`);
  const intents: unknown = Reflect.get(Object(value), "intents");
  if (!Array.isArray(intents)) throw new Error("invalid-receipt: intents");
  return {
    kind,
    sequence: integer(value, "sequence"),
    intents: intents.map((intent: unknown) => ({
      kind: intentKind(text(intent, "kind")),
      runId: text(intent, "runId"),
      operationId: text(intent, "operationId"),
    })),
  };
}

export function json(value: unknown): JsonObject {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(copy)) throw new Error("invalid-json-object");
  return copy;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
