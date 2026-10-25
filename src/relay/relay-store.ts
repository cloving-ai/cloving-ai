import { chmod, open } from "node:fs/promises";
import { join } from "node:path";
import {
  createRuntime,
  Rejected,
  type AuthorizationInput,
  type DestroyAuthorizationInput,
  type SolidObjectsRuntime,
} from "solid-objects";
import { sqlite } from "solid-objects/database/sqlite";
import { postEnvelopes } from "./envelope-post.ts";
import {
  deviceRemoved,
  PhoneDelivery,
  postEnvelopesEffect,
  type DeviceDelivery,
  type DeviceEnvelopes,
  type PostedEnvelope,
} from "./phone-delivery.ts";
import { PhoneDevices, type PhoneDevice } from "./phone-devices.ts";
import { PhoneInbox, type InboxWork } from "./phone-inbox.ts";
import {
  outboxIdentity,
  PhoneOutbox,
  type OpenDecision,
} from "./phone-outbox.ts";

const relayPrincipal = Object.freeze({ principal: "phone-relay" });
const devicesIdentity = "phone";
const inboxIdentity = "phone";
const relayActors: ReadonlySet<string> = new Set([
  PhoneDevices.actorType,
  PhoneDelivery.actorType,
  PhoneOutbox.actorType,
  PhoneInbox.actorType,
]);

function authorized(input: AuthorizationInput): boolean {
  return (
    relayActors.has(input.actorType) &&
    input.authorizationContext === relayPrincipal
  );
}

function destroyable(input: DestroyAuthorizationInput): boolean {
  return (
    input.actorType === PhoneDelivery.actorType &&
    input.authorizationContext === relayPrincipal
  );
}

function connected(
  devices: readonly PhoneDevice[],
  deviceId: unknown,
): boolean {
  return devices.some(
    (device) =>
      device.deviceId === deviceId &&
      device.state === "connected" &&
      device.removedAt === null,
  );
}

export interface DeliveryOffer {
  readonly runId: string;
  readonly promptDigest: string;
  readonly deviceId: string;
  readonly envelopes: readonly PostedEnvelope[];
}

export interface DeliveryClosing {
  readonly devices: readonly DeviceEnvelopes[];
  readonly at: number;
}

export interface RelayStore {
  readonly devices: () => Promise<readonly PhoneDevice[]>;
  readonly add: (device: PhoneDevice) => Promise<string | undefined>;
  readonly connect: (deviceId: string) => Promise<boolean>;
  readonly nextSequence: (deviceId: string) => Promise<number>;
  readonly remove: (deviceId: string) => Promise<boolean>;
  readonly removeAll: () => Promise<number>;
  readonly delivery: RelayDeliveries;
  readonly inbox: RelayInbox;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RelayDeliveries {
  readonly offer: (
    decisionId: string,
    offer: DeliveryOffer,
  ) => Promise<boolean>;
  readonly close: (
    decisionId: string,
    closing: DeliveryClosing,
  ) => Promise<boolean>;
  readonly open: () => Promise<readonly OpenDecision[]>;
  readonly list: (decisionId: string) => Promise<readonly DeviceDelivery[]>;
  readonly promptDigest: (decisionId: string) => Promise<string | null>;
  readonly sweep: () => Promise<number>;
  readonly drainAt: (now: Date) => Promise<void>;
}

export interface RelayInbox {
  readonly cursor: () => Promise<number>;
  readonly work: (answerId: string) => Promise<InboxWork | undefined>;
  readonly record: (work: InboxWork) => Promise<InboxWork>;
  readonly complete: (done: {
    readonly answerId: string;
    readonly sequence: number;
  }) => Promise<void>;
}

export interface RelayStoreOptions {
  readonly now?: () => number;
}

function relayDeliveries(runtime: SolidObjectsRuntime): RelayDeliveries {
  const outbox = runtime
    .ref(PhoneOutbox, outboxIdentity)
    .with({ authorizationContext: relayPrincipal });
  const delivery = (decisionId: string) =>
    runtime
      .ref(PhoneDelivery, decisionId)
      .with({ authorizationContext: relayPrincipal });
  return {
    offer: async (decisionId, offer) => {
      await outbox.track({ decisionId, runId: offer.runId });
      return delivery(decisionId).offer({
        deviceId: offer.deviceId,
        envelopes: offer.envelopes,
        promptDigest: offer.promptDigest,
      });
    },
    close: async (decisionId, closing) => {
      const closed = await delivery(decisionId).close(closing);
      await outbox.untrack({ decisionId });
      return closed;
    },
    open: async () => [...(await outbox.decisions)],
    list: async (decisionId) => [...(await delivery(decisionId).deliveries)],
    promptDigest: async (decisionId) => delivery(decisionId).promptDigest,
    sweep: async () => {
      const retired = [...(await outbox.retired)];
      for (const decisionId of retired) {
        await runtime
          .ref(PhoneDelivery, decisionId)
          .destroy({ authorizationContext: relayPrincipal });
        await outbox.forget({ decisionId });
      }
      return retired.length;
    },
    drainAt: async (now) => {
      await runtime.testing.runDueReminders({ now });
      await runtime.testing.drain({ roles: ["actors", "effects"] });
    },
  };
}

function relayInbox(runtime: SolidObjectsRuntime): RelayInbox {
  const inbox = runtime
    .ref(PhoneInbox, inboxIdentity)
    .with({ authorizationContext: relayPrincipal });
  return {
    cursor: async () => inbox.cursor,
    work: async (answerId) =>
      (await inbox.work).find((item) => item.answerId === answerId),
    record: (work) => inbox.record(work),
    complete: (done) => inbox.complete(done),
  };
}

export async function openRelayStore(
  phoneDirectory: string,
  options: RelayStoreOptions = {},
): Promise<RelayStore> {
  const path = join(phoneDirectory, "relay.sqlite3");
  await (await open(path, "a", 0o600)).close();
  await chmod(path, 0o600);
  const runtime = createRuntime({
    database: sqlite({ path }),
    authorizeMessage: authorized,
    authorizeQuery: authorized,
    authorizeDestroy: destroyable,
  });
  await runtime.install();
  runtime.register(PhoneDevices);
  runtime.register(PhoneDelivery);
  runtime.register(PhoneOutbox);
  runtime.register(PhoneInbox);
  const devices = runtime
    .ref(PhoneDevices, devicesIdentity)
    .with({ authorizationContext: relayPrincipal });
  const now = options.now ?? (() => Date.now());
  runtime.registerEffect(postEnvelopesEffect, async (request) => {
    if (!connected(await devices.devices, request["deviceId"]))
      return { at: now(), failure: deviceRemoved };
    return postEnvelopes({ phoneDirectory, now }, request);
  });
  return {
    devices: async () => [...(await devices.devices)],
    add: async (device) => {
      try {
        await devices.add({ device });
        return undefined;
      } catch (error) {
        if (error instanceof Rejected) return error.code.replaceAll("_", "-");
        throw error;
      }
    },
    connect: (deviceId) => devices.connect({ deviceId }),
    nextSequence: (deviceId) => devices.nextSequence({ deviceId }),
    remove: (deviceId) =>
      devices.remove({ deviceId, removedAt: new Date().toISOString() }),
    removeAll: () => devices.removeAll({ removedAt: new Date().toISOString() }),
    delivery: relayDeliveries(runtime),
    inbox: relayInbox(runtime),
    run: (signal) => runtime.run(signal),
    close: () => runtime.close(),
  };
}
