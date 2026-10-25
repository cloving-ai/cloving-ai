import type { PhoneDevice } from "../src/relay/phone-devices.ts";
import {
  heartbeatTiming,
  type HeartbeatContext,
} from "../src/relay/relay-heartbeat.ts";
import type { RelayStore } from "../src/relay/relay-store.ts";

export function heartbeatContext(
  store: RelayStore,
  settings: {
    readonly phoneDirectory: string;
    readonly waits: number[];
    readonly stop: AbortController;
    readonly count: number;
  },
): HeartbeatContext {
  return {
    phoneDirectory: settings.phoneDirectory,
    store,
    lost: () => undefined,
    timing: heartbeatTiming,
    wait: (milliseconds) => {
      settings.waits.push(milliseconds);
      if (settings.waits.length === settings.count) settings.stop.abort();
      return Promise.resolve();
    },
  };
}

export const knownDevice: PhoneDevice = {
  deviceId: "phone-1",
  name: "Pixel",
  platform: "android",
  agreementPublicKey: "a",
  answerPublicKey: "b",
  approvalPublicKey: "c",
  pairedAt: "2026-10-25T12:00:00Z",
  state: "connected",
  removedAt: null,
};
