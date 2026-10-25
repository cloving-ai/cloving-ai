import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Fields, Reply, ServiceRequest } from "../protocol.ts";
import {
  pairingSessions,
  RegistrationEnded,
  type OpenPairing,
  type PairingSessions,
} from "./pairing-session.ts";
import { listenPhoneSocket } from "./phone-socket.ts";
import { relayOrigin } from "./relay-http.ts";
import {
  forgetRegistration,
  readLink,
  registration,
  type RegistrationContext,
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
}

export interface Relay {
  readonly close: () => Promise<void>;
}

interface RelayState {
  readonly context: RegistrationContext;
  readonly store: RelayStore;
  readonly sessions: PairingSessions;
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

function result(fields: Fields): Reply {
  return { kind: "result", result: fields };
}

async function phoneState(relay: RelayState): Promise<Reply> {
  const link = await readLink(relay.context.phoneDirectory);
  const open = relay.sessions.current();
  return result({
    registered: link !== undefined,
    daemonId: link?.daemonId ?? null,
    origin: link?.origin ?? null,
    pairing:
      open === undefined
        ? null
        : {
            pairingId: open.pairingId,
            expiresAt: open.expiresAt,
            stage: "open",
          },
    devices: await relay.store.devices(),
  });
}

async function opened(relay: RelayState): Promise<OpenPairing> {
  try {
    return await relay.sessions.start(await registration(relay.context));
  } catch (error) {
    if (!(error instanceof RegistrationEnded)) throw error;
    await forgetRegistration(relay.context.phoneDirectory);
    return relay.sessions.start(await registration(relay.context));
  }
}

async function pairStart(relay: RelayState): Promise<Reply> {
  const open = relay.sessions.current() ?? (await opened(relay));
  return result({ link: open.link, expiresAt: open.expiresAt });
}

function pairCancel(relay: RelayState): Promise<Reply> {
  relay.sessions.cancel();
  return Promise.resolve(result({ pairing: null }));
}

const operations: Readonly<
  Record<string, (relay: RelayState) => Promise<Reply>>
> = {
  "phone-state": phoneState,
  "phone-pair-start": pairStart,
  "phone-pair-cancel": pairCancel,
};

export function computerName(name: string): string {
  return name.replace(/\.local$/, "").slice(0, 64);
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  await mkdir(options.runtimeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(options.phoneDirectory, { recursive: true, mode: 0o700 });
  const store = await openRelayStore(options.phoneDirectory);
  const relay: RelayState = {
    context: {
      phoneDirectory: options.phoneDirectory,
      origin: options.origin ?? relayOrigin(undefined),
      computerName: options.computerName ?? computerName(hostname()),
    },
    store,
    sessions: pairingSessions(options.secret ?? (() => randomBytes(16))),
  };
  const socket = await listenPhoneSocket(
    join(options.runtimeDirectory, "phone.sock"),
    (request) =>
      (
        operations[request.operation] ??
        (() => Promise.resolve(unknownOperation(request)))
      )(relay),
  );
  return {
    close: async () => {
      relay.sessions.cancel();
      await socket.close();
      await store.close();
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
