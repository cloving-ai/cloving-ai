import { chmod, open } from "node:fs/promises";
import { join } from "node:path";
import {
  createRuntime,
  Rejected,
  type AuthorizationInput,
} from "solid-objects";
import { sqlite } from "solid-objects/database/sqlite";
import { postEnvelopes } from "./envelope-post.ts";
import {
  deviceRemoved,
  PhoneDelivery,
  postEnvelopesEffect,
  type DeviceDelivery,
  type PostedEnvelope,
} from "./phone-delivery.ts";
import { PhoneDevices, type PhoneDevice } from "./phone-devices.ts";

const relayPrincipal = Object.freeze({ principal: "phone-relay" });
const devicesIdentity = "phone";
const relayActors: ReadonlySet<string> = new Set([
  PhoneDevices.actorType,
  PhoneDelivery.actorType,
]);

function authorized(input: AuthorizationInput): boolean {
  return (
    relayActors.has(input.actorType) &&
    input.authorizationContext === relayPrincipal
  );
}

function postRefusal(
  devices: readonly PhoneDevice[],
  deviceId: unknown,
): string | null {
  const device = devices.find((item) => item.deviceId === deviceId);
  if (device === undefined || device.removedAt !== null) return deviceRemoved;
  return device.state === "connected" ? null : "device-not-connected";
}

export interface DeliveryOffer {
  readonly deviceId: string;
  readonly envelopes: readonly PostedEnvelope[];
}

export interface RelayStore {
  readonly devices: () => Promise<readonly PhoneDevice[]>;
  readonly add: (device: PhoneDevice) => Promise<string | undefined>;
  readonly connect: (deviceId: string) => Promise<boolean>;
  readonly nextSequence: (deviceId: string) => Promise<number>;
  readonly remove: (deviceId: string) => Promise<boolean>;
  readonly removeAll: () => Promise<number>;
  readonly delivery: RelayDeliveries;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RelayDeliveries {
  readonly offer: (
    decisionId: string,
    offer: DeliveryOffer,
  ) => Promise<boolean>;
  readonly list: (decisionId: string) => Promise<readonly DeviceDelivery[]>;
  readonly drainAt: (now: Date) => Promise<void>;
}

export interface RelayStoreOptions {
  readonly now?: () => number;
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
  });
  await runtime.install();
  runtime.register(PhoneDevices);
  runtime.register(PhoneDelivery);
  const devices = runtime
    .ref(PhoneDevices, devicesIdentity)
    .with({ authorizationContext: relayPrincipal });
  const now = options.now ?? (() => Date.now());
  runtime.registerEffect(postEnvelopesEffect, async (request) => {
    const refusal = postRefusal(await devices.devices, request["deviceId"]);
    if (refusal !== null) return { at: now(), failure: refusal };
    return postEnvelopes({ phoneDirectory, now }, request);
  });
  const delivery = (decisionId: string) =>
    runtime
      .ref(PhoneDelivery, decisionId)
      .with({ authorizationContext: relayPrincipal });
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
    delivery: {
      offer: (decisionId, offer) => delivery(decisionId).offer(offer),
      list: async (decisionId) => [...(await delivery(decisionId).deliveries)],
      drainAt: async (now) => {
        await runtime.testing.runDueReminders({ now });
        await runtime.testing.drain({ roles: ["actors", "effects"] });
      },
    },
    run: (signal) => runtime.run(signal),
    close: () => runtime.close(),
  };
}
