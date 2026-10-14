import type { JsonObject } from "solid-objects";
import { loadCurrent } from "../../storage/decision-snapshots.ts";
import { integer } from "../../storage/domain-rows.ts";
import {
  authorityIdentity,
  createSchema,
} from "../../storage/domain-schema.ts";
import { restore } from "../authority-restore.ts";
import {
  ownedRuntime,
  recoverDeliveries,
  refused,
  type AuthorityOptions,
  type Owned,
  type OwnedRuntime,
  type Refusal,
} from "./authority-runtime.ts";
import { json } from "./authority-receipts.ts";
import { upgradeSteps } from "./authority-upgrades.ts";
import { authoritySession, type Authority } from "./authority-session.ts";

export type {
  AdapterOutcome,
  Delivery,
  DeliveryIntent,
  Reconciliation,
} from "./authority-delivery.ts";
export type {
  AuthorityOptions,
  AuthorityTiming,
  Refusal,
} from "./authority-runtime.ts";
export type { EffectSettings } from "./authority-settings.ts";
export type { OperationView, StoredDisposition } from "./effect-queries.ts";
export { authorityTiming } from "./authority-runtime.ts";
export type {
  AuthorityQueries,
  CommandRecord,
  EventPage,
  PublishedEvent,
} from "./authority-queries.ts";
export type {
  Authority,
  CommandContext,
  OperationRecord,
  StoreReceipt,
  StoredState,
} from "./authority-session.ts";

export type AuthorityOpening =
  { readonly kind: "opened"; readonly authority: Authority } | Refusal;

export async function openAuthority(
  directory: string,
  options: AuthorityOptions = {},
): Promise<AuthorityOpening> {
  const owned = await ownedRuntime(directory, options);
  if (owned.kind === "refused") return owned;
  let actorId: string | Refusal;
  try {
    actorId = await validated(owned);
  } catch (error) {
    actorId = refused("storage-failure", error);
  }
  if (typeof actorId !== "string") {
    await owned.parts.stop();
    return actorId;
  }
  return start({ owned, actorId, options });
}

async function validated(owned: Owned): Promise<string | Refusal> {
  const { database, schema } = owned;
  if (schema.kind === "new") await database.transaction(createSchema);
  if (schema.kind === "baseline") return conversionRequired("schema version 1");
  const upgrade = await upgraded(owned);
  if (upgrade !== undefined) return upgrade;
  const restored = restore(await database.connection(loadCurrent));
  if (restored.kind === "refused") return restored;
  const identity = await database.connection(authorityIdentity);
  if (identity.pendingAdoption !== null)
    return conversionRequired("adoption pending");
  return identity.actorId;
}

async function upgraded(owned: Owned): Promise<Refusal | undefined> {
  const { database, schema } = owned;
  for (const step of upgradeSteps(schema.kind)) {
    const restored = restore(await database.connection(step.load));
    if (restored.kind === "refused") return restored;
    const identity = await database.connection(authorityIdentity);
    if (identity.pendingAdoption !== null)
      return conversionRequired("adoption pending");
    await step.apply(database, restored.state);
  }
  return undefined;
}

function conversionRequired(detail: string): Refusal {
  return { kind: "refused", reason: "conversion-required", detail };
}

async function begun(opening: {
  readonly owned: OwnedRuntime;
  readonly actorId: string;
}): Promise<number | Refusal> {
  const { owned, actorId } = opening;
  const { parts } = owned;
  const authority = parts.invoker(actorId);
  await parts.runtime.install();
  const stored = await parts.storedActorRefusal(actorId);
  if (stored !== undefined) return stored;
  await parts.releaseEarlierOwners();
  await parts.retryDeliveryCallbacks();
  const opened = await authority.beginEpoch();
  await recoverDeliveries(authority);
  const condition = await parts.condition();
  if (condition !== undefined)
    return {
      kind: "refused",
      reason: "unresolved-delivery",
      detail: condition,
    };
  return integer(opened, "epoch");
}

async function start(opening: {
  readonly owned: OwnedRuntime;
  readonly actorId: string;
  readonly options: AuthorityOptions;
}): Promise<AuthorityOpening> {
  const { owned, actorId, options } = opening;
  const { database, parts } = owned;
  let epoch: number | Refusal;
  try {
    epoch = await begun({ owned, actorId });
  } catch (error) {
    epoch = refused("authority-unavailable", error);
  }
  if (typeof epoch !== "number") {
    await parts.stop();
    return epoch;
  }
  parts.setEpoch(epoch);
  const authority = parts.invoker(actorId);
  return {
    kind: "opened",
    authority: authoritySession({
      database,
      reader: parts.reader,
      execute: (request: JsonObject) => authority.execute(json(request)),
      run: (signal) => parts.runtime.run(signal),
      stop: parts.stop,
      handlersSettled: parts.handlersSettled,
      deliveryConfigured: options.delivery !== undefined,
      epoch,
      ...parts.limits,
      unhealthy: parts.unhealthy,
      condition: parts.condition,
      watchMilliseconds: parts.watchMilliseconds,
      subscribe: (listener) => parts.subscribe(actorId, listener),
    }),
  };
}
