import { chmod, open } from "node:fs/promises";
import { join } from "node:path";
import {
  createRuntime,
  Rejected,
  type AuthorizationInput,
} from "solid-objects";
import { sqlite } from "solid-objects/database/sqlite";
import { PhoneDevices, type PhoneDevice } from "./phone-devices.ts";

const relayPrincipal = Object.freeze({ principal: "phone-relay" });
const devicesIdentity = "phone";

function authorized(input: AuthorizationInput): boolean {
  return (
    input.actorType === PhoneDevices.actorType &&
    input.authorizationContext === relayPrincipal
  );
}

export interface RelayStore {
  readonly devices: () => Promise<readonly PhoneDevice[]>;
  readonly add: (device: PhoneDevice) => Promise<string | undefined>;
  readonly connect: (deviceId: string) => Promise<boolean>;
  readonly remove: (deviceId: string) => Promise<boolean>;
  readonly removeAll: () => Promise<number>;
  readonly close: () => Promise<void>;
}

export async function openRelayStore(
  phoneDirectory: string,
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
  const devices = runtime
    .ref(PhoneDevices, devicesIdentity)
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
    remove: (deviceId) =>
      devices.remove({ deviceId, removedAt: new Date().toISOString() }),
    removeAll: () => devices.removeAll({ removedAt: new Date().toISOString() }),
    close: () => runtime.close(),
  };
}
