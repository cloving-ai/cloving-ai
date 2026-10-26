import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Fields, Reply } from "../protocol.ts";
import { signedReceipt } from "./pairing-checks.ts";
import { denied } from "./pairing-follow.ts";
import type { OpenPairing, PairingSessions } from "./pairing-session.ts";
import { relayRequest } from "./relay-http.ts";
import { readLink, type RegistrationContext } from "./relay-registration.ts";
import type { RelayStore } from "./relay-store.ts";

export interface OperationState {
  readonly context: RegistrationContext;
  readonly store: RelayStore;
  readonly sessions: PairingSessions;
  readonly registration: { lost: boolean };
}

export function result(fields: Fields): Reply {
  return { kind: "result", result: fields };
}

export function refused(code: string, detail: string): Reply {
  return { kind: "error", error: { code, detail } };
}

function requestedPairing(relay: OperationState): OpenPairing | undefined {
  const open = relay.sessions.current();
  return open?.stage === "requested" && open.request !== undefined
    ? open
    : undefined;
}

const noRequest = refused(
  "pairing-not-requested",
  "No phone waits for an answer. Click Connect a phone and scan the code again.",
);

const changed = refused(
  "pairing-changed",
  "The pairing changed. Check the name and the code on the watch page again.",
);

const acceptances = new WeakMap<OpenPairing, Promise<Reply>>();

export function pairAccept(
  relay: OperationState,
  parameters: Fields,
): Promise<Reply> {
  const open = requestedPairing(relay);
  if (open === undefined) return Promise.resolve(noRequest);
  if (parameters["pairingId"] !== open.pairingId)
    return Promise.resolve(changed);
  const running = acceptances.get(open);
  if (running !== undefined) return running;
  const accepting = accepted(relay, open).finally(() =>
    acceptances.delete(open),
  );
  acceptances.set(open, accepting);
  return accepting;
}

async function accepted(
  relay: OperationState,
  open: OpenPairing,
): Promise<Reply> {
  const { request } = open;
  if (request === undefined) return noRequest;
  const pairedAt = new Date().toISOString();
  const rejection = await relay.store.add({
    deviceId: request.deviceId,
    name: request.name,
    platform: request.platform,
    agreementPublicKey: request.agreementPublicKey,
    answerPublicKey: request.answerPublicKey,
    approvalPublicKey: request.approvalPublicKey,
    pairedAt,
    state: "checking",
    removedAt: null,
  });
  if (rejection !== undefined) {
    await denied(open);
    relay.sessions.end(open, rejection);
    return refused(
      rejection,
      "This phone was removed. Connect it as a new phone.",
    );
  }
  const { receipt, nonce } = signedReceipt(open.registration.keys, {
    daemonId: open.registration.link.daemonId,
    deviceId: request.deviceId,
    pairedAt,
  });
  const reply = await relayRequest(open.registration.link.origin, {
    method: "POST",
    path: `/api/v1/relay/pairings/${open.pairingId}/receipt`,
    token: open.registration.link.token,
    body: { receipt },
  });
  if (reply.status !== 200)
    return refused(
      "receipt-failed",
      `cloving.ai answered ${String(reply.status)} to the receipt.`,
    );
  open.nonce = nonce;
  open.stage = "checking";
  return result({ deviceId: request.deviceId, state: "checking" });
}

export async function pairDeny(
  relay: OperationState,
  parameters: Fields,
): Promise<Reply> {
  const open = requestedPairing(relay);
  if (open === undefined) return noRequest;
  if (parameters["pairingId"] !== open.pairingId) return changed;
  await denied(open);
  relay.sessions.end(open, null);
  return result({ pairing: null });
}

function warning(status: number, subject: string): string | null {
  if (status >= 200 && status < 300) return null;
  return `cloving.ai did not remove ${subject} (answer ${String(status)}). This computer keeps it removed.`;
}

async function serverCall(
  relay: OperationState,
  call: {
    readonly method: "DELETE";
    readonly path: string;
    readonly subject: string;
  },
): Promise<string | null> {
  const link = await readLink(relay.context.phoneDirectory);
  if (link === undefined) return null;
  const reply = await relayRequest(link.origin, {
    method: call.method,
    path: call.path,
    token: link.token,
  }).catch(() => ({ status: 0, body: null }));
  return warning(reply.status, call.subject);
}

export async function phoneRemove(
  relay: OperationState,
  parameters: Fields,
): Promise<Reply> {
  const deviceId = parameters["deviceId"];
  if (typeof deviceId !== "string" || !(await relay.store.remove(deviceId)))
    return refused("phone-unknown", "No connected phone has this device ID.");
  const notice = await serverCall(relay, {
    method: "DELETE",
    path: `/api/v1/relay/devices/${encodeURIComponent(deviceId)}`,
    subject: "the phone",
  });
  return result({ deviceId, removed: true, warning: notice });
}

export async function phoneReset(relay: OperationState): Promise<Reply> {
  relay.sessions.cancel();
  const notice = await serverCall(relay, {
    method: "DELETE",
    path: "/api/v1/relay/daemon",
    subject: "this computer",
  });
  const removed = await relay.store.removeAll();
  for (const file of ["link.json", "daemon-keys.json"])
    await rm(join(relay.context.phoneDirectory, file), { force: true });
  return result({ removed, warning: notice });
}
