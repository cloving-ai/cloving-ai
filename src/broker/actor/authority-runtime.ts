import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  guardApplicationDatabase,
  type ActorClass,
  type Database,
  type InstrumentationEvent,
  type JsonObject,
  type SolidObjectsRuntime,
} from "solid-objects";
import { sqlite } from "solid-objects/database/sqlite";
import { recoveryBatch } from "./turn-state.ts";
import { integer, latestSequence, text } from "../../storage/domain-rows.ts";
import { trackedDelivery } from "./authority-release.ts";
import { authorityActor } from "./authority-actor.ts";
import {
  contentionMilliseconds,
  lockContention,
  lockExclusively,
  observeSettings,
  requiredSettingsViolation,
  takeOwnership,
} from "./authority-connection.ts";
import {
  inspectSchema,
  type SchemaState,
} from "../../storage/domain-schema.ts";
import {
  deliveryHandler,
  type AvailableManifest,
  type Delivery,
} from "./authority-delivery.ts";
import {
  authorityTiming,
  effectConfiguration,
  type AuthorityTiming,
  type EffectSettings,
} from "./authority-settings.ts";
import {
  failureCounter,
  registeredRuntime,
  runtimeSettings,
  wallClock,
} from "./runtime-parts.ts";
import {
  strandingWatchdog,
  type StrandingWatchdog,
} from "./authority-watchdog.ts";

export interface AuthorityOptions {
  readonly delivery?: Delivery;
  readonly timing?: AuthorityTiming;
  readonly effects?: Partial<EffectSettings>;
  readonly clock?: () => string;
  readonly instrumentation?: (event: InstrumentationEvent) => void;
  readonly log?: (line: string) => void;
  readonly available?: AvailableManifest;
}

export interface Refusal {
  readonly kind: "refused";
  readonly reason: string;
  readonly detail: string;
}

export { authorityTiming } from "./authority-settings.ts";
export type { AuthorityTiming } from "./authority-settings.ts";

export function refused(reason: string, error: unknown): Refusal {
  return {
    kind: "refused",
    reason,
    detail: String(Reflect.get(Object(error), "message")),
  };
}

export interface Owned {
  readonly kind: "owned";
  readonly database: Database;
  readonly schema: Exclude<SchemaState, Refusal>;
}

export async function ownedDatabase(
  directory: string,
): Promise<Owned | Refusal> {
  let database: Database;
  try {
    database = sqlite({
      path: join(await realpath(directory), "authority.sqlite"),
      timeoutMilliseconds: contentionMilliseconds,
      lockRetryAttempts: 1,
    });
  } catch (error) {
    return refused("storage-failure", error);
  }
  const owned = await ownership(database);
  if (owned.kind === "owned") return owned;
  await database.close();
  return owned;
}

async function ownership(database: Database): Promise<Owned | Refusal> {
  let schema: SchemaState;
  try {
    await lockExclusively(database);
    schema = await database.connection(inspectSchema);
    if (schema.kind === "refused") return schema;
    await takeOwnership(database);
  } catch (error) {
    return refused(
      lockContention(error) ? "authority-held" : "storage-failure",
      error,
    );
  }
  const violation = requiredSettingsViolation(await observeSettings(database));
  return violation === null
    ? { kind: "owned", database, schema }
    : { kind: "refused", reason: "storage-failure", detail: violation };
}

export interface OwnedRuntime extends Owned {
  readonly parts: AuthorityRuntime;
}

export async function ownedRuntime(
  directory: string,
  options: AuthorityOptions,
): Promise<OwnedRuntime | Refusal> {
  const owned = await ownedDatabase(directory);
  if (owned.kind === "refused") return owned;
  try {
    return { ...owned, parts: authorityRuntime(owned.database, options) };
  } catch (error) {
    await owned.database.close();
    return refused("invalid-configuration", error);
  }
}

export interface AuthorityInvoker {
  readonly beginEpoch: () => Promise<unknown>;
  readonly execute: (request: JsonObject) => Promise<unknown>;
  readonly adopt: () => Promise<unknown>;
  readonly recover: () => Promise<unknown>;
}

export async function recoverDeliveries(
  invoker: AuthorityInvoker,
): Promise<number> {
  let staged = 0;
  for (;;) {
    const batch = integer(await invoker.recover(), "staged");
    staged += batch;
    if (batch < recoveryBatch) return staged;
  }
}

export interface SessionLimits {
  readonly stopLimit: number;
  readonly recoveryLimit: number;
}

export interface AuthorityRuntime {
  readonly runtime: SolidObjectsRuntime;
  readonly reader: Database;
  readonly invoker: (
    actorId: string,
    idempotencyKey?: string,
  ) => AuthorityInvoker;
  readonly stop: () => Promise<void>;
  readonly handlersSettled: () => Promise<boolean>;
  readonly setEpoch: (epoch: number) => void;
  readonly unhealthy: () => string | undefined;
  readonly halted: AbortSignal;
  readonly watchMilliseconds: number;
  readonly limits: SessionLimits;
  readonly releaseEarlierOwners: () => Promise<void>;
  readonly retryDeliveryCallbacks: () => Promise<void>;
  readonly storedActorRefusal: (
    actorId: string,
  ) => Promise<Refusal | undefined>;
  readonly condition: () => Promise<string | undefined>;
}

function unhealthy(watchdog: StrandingWatchdog): string | undefined {
  const dead = watchdog.deadLettered();
  if (dead !== undefined) return `dead-lettered message ${dead}`;
  const stranded = watchdog.stranded();
  return stranded === undefined ? undefined : `stranded message ${stranded}`;
}

const deliveryCallbacks = ["deliveryCompleted", "deliveryFailed"];

async function retryDeliveryCallbacks(retry: {
  readonly runtime: SolidObjectsRuntime;
  readonly broker: object;
}): Promise<void> {
  const administration = { authorizationContext: retry.broker };
  const letters = await retry.runtime.deadLetters.all(administration);
  for (const letter of letters.filter(
    (item) =>
      item.actorType === "ClovingAuthority" &&
      deliveryCallbacks.includes(item.operation) &&
      item.retriedMessageId === null,
  ))
    await retry.runtime.deadLetters.retry(letter.id, administration);
}

async function releaseEarlierOwners(release: {
  readonly runtime: SolidObjectsRuntime;
  readonly broker: object;
  readonly timing: AuthorityTiming;
}): Promise<void> {
  const { runtime, broker, timing } = release;
  const administration = { authorizationContext: broker };
  const bound =
    timing.aliveThresholdMilliseconds + 2 * timing.heartbeatMilliseconds;
  for (let waited = 0; ; waited += timing.heartbeatMilliseconds) {
    await runtime.processes.cleanup(administration);
    const earlier = (await runtime.processes.all(administration)).filter(
      (record) => record.shutdownState !== "stopped",
    );
    if (earlier.length === 0) return;
    if (waited > bound)
      throw new Error(
        `earlier-owner-not-released: ${earlier.map((record) => record.id).join(",")}`,
      );
    await delay(timing.heartbeatMilliseconds);
  }
}

const actorSequenceMismatch: Refusal = {
  kind: "refused",
  reason: "projection-mismatch",
  detail: "actor-sequence",
};

async function storedActorRefusal(check: {
  readonly database: Database;
  readonly actor: ActorClass;
  readonly actorId: string;
}): Promise<Refusal | undefined> {
  const { database, actor, actorId } = check;
  const supported = actor.stateVersion ?? 1;
  const { row, latest } = await database.connection(async (connection) => ({
    row: await connection.get(
      "SELECT state_version, state FROM solid_instances WHERE actor_type = ? AND actor_id = ?",
      [actor.actorType, actorId],
    ),
    latest: await latestSequence(connection),
  }));
  const version = row === undefined ? supported : integer(row, "state_version");
  if (version > supported)
    return {
      kind: "refused",
      reason: "incompatible-state-version",
      detail: `stored state version ${String(version)} is newer than code version ${String(supported)}`,
    };
  const sequence =
    row === undefined ? 0 : integer(JSON.parse(text(row, "state")), "sequence");
  return sequence === latest ? undefined : actorSequenceMismatch;
}

async function condition(watch: {
  readonly runtime: SolidObjectsRuntime;
  readonly broker: object;
  readonly watchdog: StrandingWatchdog;
}): Promise<string | undefined> {
  const { runtime, broker, watchdog } = watch;
  const dead = watchdog.deadLettered();
  if (dead === undefined) return unhealthy(watchdog);
  return `dead-lettered message ${dead}: ${await deadLetterCause({ runtime, broker, messageId: dead })}`;
}

async function deadLetterCause(lookup: {
  readonly runtime: SolidObjectsRuntime;
  readonly broker: object;
  readonly messageId: string;
}): Promise<string> {
  const { runtime, broker, messageId } = lookup;
  try {
    const letters = await runtime.deadLetters.all({
      authorizationContext: broker,
    });
    const letter = letters.find((item) => item.messageId === messageId);
    return String(Reflect.get(Object(letter?.error), "message"));
  } catch {
    return "unreadable cause";
  }
}

export function authorityRuntime(
  database: Database,
  options: AuthorityOptions,
): AuthorityRuntime {
  const timing = options.timing ?? authorityTiming;
  const reader = guardApplicationDatabase(database);
  const broker = {};
  let epoch = 0;
  const halt = new AbortController();
  const watchdog = strandingWatchdog({
    boundMilliseconds: timing.callTimeoutMilliseconds,
    whenStranded: halt.abort.bind(halt),
  });
  const effects = effectConfiguration(options);
  const shared = { reader, effects, clock: options.clock ?? wallClock };
  const ClovingAuthority = authorityActor({
    ...shared,
    failed: failureCounter(),
  });
  const runtime = registeredRuntime({
    database,
    actor: ClovingAuthority,
    settings: runtimeSettings({ timing, options, broker, watchdog }),
  });
  const delivery = trackedDelivery({
    runtime,
    database,
    shutdownMilliseconds: timing.shutdownMilliseconds,
    handle: deliveryHandler({
      ...shared,
      delivery: options.delivery,
      epoch: () => epoch,
      available: options.available,
    }),
  });
  return {
    runtime,
    reader,
    invoker: (actorId, idempotencyKey) =>
      runtime.ref(ClovingAuthority, actorId).with({
        authorizationContext: broker,
        timeoutMilliseconds: timing.callTimeoutMilliseconds,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }),
    ...delivery,
    setEpoch: (value) => {
      epoch = value;
    },
    unhealthy: () => unhealthy(watchdog),
    halted: halt.signal,
    watchMilliseconds: timing.leaseMilliseconds,
    limits: effects,
    releaseEarlierOwners: () =>
      releaseEarlierOwners({ runtime, broker, timing }),
    retryDeliveryCallbacks: () => retryDeliveryCallbacks({ runtime, broker }),
    storedActorRefusal: (actorId) =>
      storedActorRefusal({ database, actor: ClovingAuthority, actorId }),
    condition: () => condition({ runtime, broker, watchdog }),
  };
}
