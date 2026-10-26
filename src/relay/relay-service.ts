import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Fields, Reply, ServiceRequest } from "../protocol.ts";
import { inboxTiming, runInbox, type InboxTiming } from "./answer-inbox.ts";
import {
  watchDecisions,
  watchTiming,
  type WatchTiming,
} from "./decision-watch.ts";
import { followPairing } from "./pairing-follow.ts";
import {
  pairingSessions,
  RegistrationEnded,
  type OpenPairing,
} from "./pairing-session.ts";
import {
  pairAccept,
  pairDeny,
  phoneRemove,
  phoneReset,
  result,
  type OperationState,
} from "./phone-operations.ts";
import { listenPhoneSocket } from "./phone-socket.ts";
import {
  heartbeatTiming,
  runHeartbeats,
  type HeartbeatTiming,
} from "./relay-heartbeat.ts";
import { relayControl } from "./relay-control.ts";
import { relayOrigin } from "./relay-http.ts";
import {
  forgetRegistration,
  readLink,
  registration,
} from "./relay-registration.ts";
import { openRelayStore, type RelayStore } from "./relay-store.ts";

export interface RelayPaths {
  readonly runtimeDirectory: string;
  readonly phoneDirectory: string;
}

export interface RelayOptions extends RelayPaths {
  readonly origin?: string;
  readonly computerName?: string;
  readonly secret?: () => Buffer;
  readonly heartbeatTiming?: HeartbeatTiming;
  readonly watchTiming?: WatchTiming;
  readonly inboxTiming?: InboxTiming;
}

export interface Relay {
  readonly close: () => Promise<void>;
}

function unknownOperation(request: ServiceRequest): Reply {
  return {
    kind: "error",
    error: {
      code: "unknown-operation",
      detail: `The phone relay has no operation ${request.operation}.`,
    },
  };
}

function pairingView(open: OpenPairing | undefined): Fields | null {
  if (open === undefined) return null;
  const request = open.request;
  return {
    pairingId: open.pairingId,
    expiresAt: open.expiresAt,
    stage: open.stage,
    request:
      request === undefined
        ? null
        : {
            deviceId: request.deviceId,
            name: request.name,
            platform: request.platform,
            code: request.code,
          },
  };
}

async function phoneState(relay: OperationState): Promise<Reply> {
  const link = await readLink(relay.context.phoneDirectory);
  return result({
    registered: link !== undefined,
    daemonId: link?.daemonId ?? null,
    origin: link?.origin ?? null,
    pairing: pairingView(relay.sessions.current()),
    refusal: relay.sessions.refusal(),
    reason: relay.registration.lost ? "registration-lost" : null,
    devices: (await relay.store.devices()).map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      pairedAt: device.pairedAt,
      state: device.state,
      removedAt: device.removedAt,
    })),
  });
}

async function opened(relay: OperationState): Promise<OpenPairing> {
  const startedIn = relay.sessions.generation();
  try {
    return await relay.sessions.start(
      await registration(relay.context),
      startedIn,
    );
  } catch (error) {
    if (!(error instanceof RegistrationEnded)) throw error;
    await relay.store.removeAll();
    await forgetRegistration(relay.context.phoneDirectory);
    return relay.sessions.start(await registration(relay.context), startedIn);
  }
}

const starts = new WeakMap<OperationState, Promise<OpenPairing>>();

function sharedStart(relay: OperationState): Promise<OpenPairing> {
  const running = starts.get(relay);
  if (running !== undefined) return running;
  const starting = opened(relay).finally(() => starts.delete(relay));
  starts.set(relay, starting);
  return starting;
}

async function pairStart(relay: OperationState): Promise<Reply> {
  const open = relay.sessions.current() ?? (await sharedStart(relay));
  relay.registration.lost = false;
  return result({ link: open.link, expiresAt: open.expiresAt });
}

function pairCancel(relay: OperationState): Promise<Reply> {
  relay.sessions.cancel();
  return Promise.resolve(result({ pairing: null }));
}

async function resetAfterStart(relay: OperationState): Promise<Reply> {
  relay.sessions.cancel();
  await starts.get(relay)?.catch(() => undefined);
  return phoneReset(relay);
}

type Operation = (relay: OperationState, parameters: Fields) => Promise<Reply>;

const operations: Readonly<Record<string, Operation>> = {
  "phone-state": phoneState,
  "phone-pair-start": pairStart,
  "phone-pair-cancel": pairCancel,
  "phone-pair-accept": pairAccept,
  "phone-pair-deny": pairDeny,
  "phone-remove": phoneRemove,
  "phone-reset": resetAfterStart,
};

export function computerName(name: string): string {
  return name.replace(/\.local$/, "").slice(0, 64);
}

function deliveringStore(
  options: RelayOptions,
  opened: RelayStore,
): { readonly store: RelayStore; readonly close: () => Promise<void> } {
  const stop = new AbortController();
  const reading = new AbortController();
  const running = opened.run(stop.signal);
  const context = {
    runtimeDirectory: options.runtimeDirectory,
    phoneDirectory: options.phoneDirectory,
    store: opened,
    control: relayControl(options.runtimeDirectory),
    now: () => Date.now(),
  };
  const watch = watchDecisions(context, options.watchTiming ?? watchTiming);
  const answers = runInbox(context, {
    signal: reading.signal,
    timing: options.inboxTiming ?? inboxTiming,
  });
  return {
    store: {
      ...opened,
      connect: async (deviceId) => {
        const found = await opened.connect(deviceId);
        watch.wake();
        return found;
      },
    },
    close: async () => {
      reading.abort();
      await answers;
      await watch.close();
      stop.abort();
      await running;
    },
  };
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  await mkdir(options.runtimeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(options.phoneDirectory, { recursive: true, mode: 0o700 });
  const opened = await openRelayStore(options.phoneDirectory);
  const delivering = deliveringStore(options, opened);
  const { store } = delivering;
  const follower: { follow: (open: OpenPairing) => Promise<void> } = {
    follow: () => Promise.resolve(),
  };
  const relay: OperationState = {
    context: {
      phoneDirectory: options.phoneDirectory,
      origin: options.origin ?? relayOrigin(undefined),
      computerName: options.computerName ?? computerName(hostname()),
    },
    store,
    sessions: pairingSessions({
      secret: options.secret ?? (() => randomBytes(16)),
      follow: (open) => follower.follow(open),
    }),
    registration: { lost: false },
  };
  follower.follow = (open) => followPairing(relay, open);
  const socket = await listenPhoneSocket(
    join(options.runtimeDirectory, "phone.sock"),
    (request) => {
      const operation = operations[request.operation];
      return operation === undefined
        ? Promise.resolve(unknownOperation(request))
        : operation(relay, request.parameters);
    },
  );
  const stop = new AbortController();
  const beating = runHeartbeats(
    {
      phoneDirectory: options.phoneDirectory,
      store,
      timing: options.heartbeatTiming ?? heartbeatTiming,
      lost: () => {
        relay.registration.lost = true;
        relay.sessions.cancel();
      },
      wait: (milliseconds, signal) =>
        delay(milliseconds, undefined, { signal }).catch(() => undefined),
    },
    stop.signal,
  );
  return {
    close: async () => {
      stop.abort();
      relay.sessions.cancel();
      await beating;
      await socket.close();
      await delivering.close();
      await opened.close();
    },
  };
}

export interface RelayProgram {
  readonly stopped: Promise<unknown>;
  readonly error: (line: string) => void;
}

export async function runRelay(
  environment: Readonly<Record<string, string | undefined>>,
  program: RelayProgram,
): Promise<number> {
  const runtimeDirectory = environment["CLOVING_RUNTIME_DIR"];
  if (runtimeDirectory === undefined || runtimeDirectory === "") {
    program.error(
      "runtime-directory-unknown: The phone relay needs CLOVING_RUNTIME_DIR.\n",
    );
    return 1;
  }
  try {
    const relay = await startRelay({
      runtimeDirectory,
      phoneDirectory: join(dirname(runtimeDirectory), "state", "phone"),
      origin: relayOrigin(environment["CLOVING_RELAY_ORIGIN"]),
    });
    await program.stopped;
    await relay.close();
    return 0;
  } catch (error) {
    program.error(
      `phone-relay-failed: ${String(Reflect.get(Object(error), "message"))}\n`,
    );
    return 1;
  }
}
