import type { PhoneDevice } from "../src/relay/phone-devices.ts";
import {
  heartbeatTiming,
  type HeartbeatContext,
} from "../src/relay/relay-heartbeat.ts";
import type { RelayStore } from "../src/relay/relay-store.ts";
import { phoneRequest } from "../src/cli/phone-client.ts";
import { setTimeout as delay } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";

export async function lostPhoneState(
  runtimeDirectory: string,
): Promise<Readonly<Record<string, unknown>>> {
  let state: Readonly<Record<string, unknown>> = {};
  for (let attempt = 0; attempt < testMilliseconds(4000) / 20; attempt += 1) {
    const reply = await phoneRequest(runtimeDirectory, {
      operation: "phone-state",
      parameters: {},
    });
    state = reply?.kind === "result" ? reply.result : {};
    if (
      state["reason"] === "registration-lost" &&
      state["registered"] === false
    )
      return state;
    await delay(20);
  }
  return state;
}

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
