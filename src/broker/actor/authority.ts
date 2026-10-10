import type { JsonObject } from "solid-objects";
import { integer, loadSnapshot } from "../../storage/domain-rows.ts";
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
import { authoritySession, json, type Authority } from "./authority-session.ts";

export type {
  Delivery,
  DeliveryIntent,
  Reconciliation,
} from "./authority-delivery.ts";
export type {
  AuthorityOptions,
  AuthorityTiming,
  Refusal,
} from "./authority-runtime.ts";
export { authorityTiming } from "./authority-runtime.ts";
export type {
  Authority,
  CommandContext,
  OperationRecord,
  StoreReceipt,
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
  const restored = restore(await database.connection(loadSnapshot));
  if (restored.kind === "refused") return restored;
  const identity = await database.connection(authorityIdentity);
  if (identity.pendingAdoption !== null)
    return conversionRequired("adoption pending");
  return identity.actorId;
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
      deliveriesInFlight: parts.deliveriesInFlight,
      deliveryConfigured: options.delivery !== undefined,
      epoch,
      unhealthy: parts.unhealthy,
      condition: parts.condition,
      watchMilliseconds: parts.watchMilliseconds,
    }),
  };
}
