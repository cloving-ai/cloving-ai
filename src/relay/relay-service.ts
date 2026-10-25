import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePhoneLink, type PhoneLink } from "../phone/phone-link.ts";
import type { Reply, ServiceRequest } from "../protocol.ts";
import { listenPhoneSocket } from "./phone-socket.ts";
import { openRelayStore, type RelayStore } from "./relay-store.ts";

export interface RelayPaths {
  readonly runtimeDirectory: string;
  readonly phoneDirectory: string;
}

export interface Relay {
  readonly close: () => Promise<void>;
}

async function readLink(
  phoneDirectory: string,
): Promise<PhoneLink | undefined> {
  const text = await readFile(join(phoneDirectory, "link.json"), "utf8").catch(
    (error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return undefined;
      throw error;
    },
  );
  return parsePhoneLink(text);
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

async function phoneState(
  paths: RelayPaths,
  store: RelayStore,
): Promise<Reply> {
  const link = await readLink(paths.phoneDirectory);
  return {
    kind: "result",
    result: {
      registered: link !== undefined,
      daemonId: link?.daemonId ?? null,
      origin: link?.origin ?? null,
      pairing: null,
      devices: await store.devices(),
    },
  };
}

export async function startRelay(paths: RelayPaths): Promise<Relay> {
  await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.phoneDirectory, { recursive: true, mode: 0o700 });
  const store = await openRelayStore(paths.phoneDirectory);
  const socket = await listenPhoneSocket(
    join(paths.runtimeDirectory, "phone.sock"),
    async (request) =>
      request.operation === "phone-state"
        ? phoneState(paths, store)
        : unknownOperation(request),
  );
  return {
    close: async () => {
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
