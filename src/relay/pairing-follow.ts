import { setTimeout as delay } from "node:timers/promises";
import {
  checkedRequest,
  checkValid,
  type RequestCheck,
} from "./pairing-checks.ts";
import type { OpenPairing, PairingSessions } from "./pairing-session.ts";
import { relayRequest, type RelayReply } from "./relay-http.ts";
import type { RelayStore } from "./relay-store.ts";

export interface FollowContext {
  readonly store: RelayStore;
  readonly sessions: PairingSessions;
}

interface Exchange {
  readonly open: OpenPairing;
  readonly body: unknown;
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null
    ? Reflect.get(body, name)
    : undefined;
}

export async function denied(open: OpenPairing): Promise<void> {
  await relayRequest(open.registration.link.origin, {
    method: "POST",
    path: `/api/v1/relay/pairings/${open.pairingId}/deny`,
    token: open.registration.link.token,
  }).catch(() => undefined);
}

async function revoked(store: RelayStore, deviceId: string): Promise<boolean> {
  return (await store.devices()).some(
    (device) => device.deviceId === deviceId && device.removedAt !== null,
  );
}

async function refusalOf(
  context: FollowContext,
  checked: RequestCheck,
): Promise<string | null> {
  if (checked.kind === "refused") return checked.code;
  const removed = await revoked(context.store, checked.request.deviceId);
  return removed ? "pairing-device-revoked" : null;
}

async function onRequest(
  context: FollowContext,
  exchange: Exchange,
): Promise<void> {
  const { open } = exchange;
  if (open.stage !== "open") return;
  const checked = checkedRequest(open.secret, field(exchange.body, "request"));
  const code = await refusalOf(context, checked);
  if (code !== null || checked.kind === "refused") {
    await denied(open);
    context.sessions.end(open, code);
    return;
  }
  open.request = checked.request;
  open.stage = "requested";
}

async function onCheck(
  context: FollowContext,
  exchange: Exchange,
): Promise<void> {
  const { open } = exchange;
  const { request, nonce } = open;
  if (open.stage !== "checking" || request === undefined || nonce === undefined)
    return;
  const valid = checkValid(field(exchange.body, "check"), {
    daemonId: open.registration.link.daemonId,
    deviceId: request.deviceId,
    nonce,
    answerPublicKey: request.answerPublicKey,
    now: Date.now(),
  });
  if (valid) await context.store.connect(request.deviceId);
  context.sessions.end(open, valid ? null : "pairing-check-invalid");
}

function onEnd(context: FollowContext, exchange: Exchange): Promise<void> {
  const { open } = exchange;
  const expired = field(exchange.body, "stage") === "expired";
  context.sessions.end(
    open,
    expired && open.stage !== "checking" ? "pairing-expired" : null,
  );
  return Promise.resolve();
}

const handlers: Readonly<
  Record<string, (context: FollowContext, exchange: Exchange) => Promise<void>>
> = {
  requested: onRequest,
  checked: onCheck,
  denied: onEnd,
  expired: onEnd,
};

async function polled(
  open: OpenPairing,
  stage: string,
): Promise<RelayReply | undefined> {
  try {
    return await relayRequest(open.registration.link.origin, {
      method: "GET",
      path: `/api/v1/relay/pairings/${open.pairingId}?wait=25&stage=${stage}`,
      token: open.registration.link.token,
      signal: open.stop.signal,
      timeoutMilliseconds: 40_000,
    });
  } catch {
    await delay(1000, undefined, { signal: open.stop.signal }).catch(
      () => undefined,
    );
    return undefined;
  }
}

export async function followPairing(
  context: FollowContext,
  open: OpenPairing,
): Promise<void> {
  let stage = "open";
  while (context.sessions.current() === open) {
    const reply = await polled(open, stage);
    if (reply === undefined) continue;
    if (reply.status !== 200) {
      context.sessions.end(open, "pairing-expired");
      return;
    }
    stage = String(field(reply.body, "stage"));
    await handlers[stage]?.(context, { open, body: reply.body });
  }
}
