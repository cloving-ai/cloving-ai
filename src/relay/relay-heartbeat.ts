import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PhoneLink } from "../phone/phone-link.ts";
import { relayRequest } from "./relay-http.ts";
import { readLink } from "./relay-registration.ts";
import type { RelayStore } from "./relay-store.ts";

export interface HeartbeatTiming {
  readonly intervalMilliseconds: number;
  readonly firstBackoffMilliseconds: number;
  readonly longestBackoffMilliseconds: number;
}

export const heartbeatTiming: HeartbeatTiming = {
  intervalMilliseconds: 60_000,
  firstBackoffMilliseconds: 5000,
  longestBackoffMilliseconds: 300_000,
};

export interface HeartbeatContext {
  readonly phoneDirectory: string;
  readonly store: RelayStore;
  readonly lost: () => void;
  readonly timing: HeartbeatTiming;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type BeatOutcome =
  "beat" | "failed" | "lost" | "replaced" | "unregistered";

function revokedDevices(body: unknown): readonly string[] {
  const devices: unknown =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "devices")
      : undefined;
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((device: unknown) => {
    const deviceId: unknown = Reflect.get(Object(device), "device_id");
    const revokedAt: unknown = Reflect.get(Object(device), "revoked_at");
    return typeof deviceId === "string" && typeof revokedAt === "string"
      ? [deviceId]
      : [];
  });
}

async function applyRevocations(
  context: HeartbeatContext,
  call: { readonly link: PhoneLink; readonly signal: AbortSignal },
): Promise<void> {
  const { link, signal } = call;
  if (signal.aborted) return;
  const reply = await relayRequest(link.origin, {
    method: "GET",
    path: "/api/v1/relay/devices",
    token: link.token,
    signal,
  });
  if (reply.status !== 200) return;
  const known = new Set(
    (await context.store.devices())
      .filter((device) => device.removedAt === null)
      .map((device) => device.deviceId),
  );
  for (const deviceId of revokedDevices(reply.body))
    if (known.has(deviceId)) await context.store.remove(deviceId);
}

async function lostRegistration(
  context: HeartbeatContext,
  link: PhoneLink,
): Promise<BeatOutcome> {
  const current = await readLink(context.phoneDirectory);
  if (current?.token !== link.token) return "replaced";
  await context.store.removeAll();
  await rm(join(context.phoneDirectory, "link.json"), { force: true });
  context.lost();
  return "lost";
}

export async function heartbeat(
  context: HeartbeatContext,
  signal: AbortSignal = new AbortController().signal,
): Promise<BeatOutcome> {
  const link = await readLink(context.phoneDirectory);
  if (link === undefined) return "unregistered";
  const reply = await relayRequest(link.origin, {
    method: "PUT",
    path: "/api/v1/relay/daemon/heartbeat",
    token: link.token,
    signal,
  }).catch(() => undefined);
  if (reply?.status === 401) return lostRegistration(context, link);
  if (reply === undefined || reply.status >= 300) return "failed";
  await applyRevocations(context, { link, signal }).catch(() => undefined);
  return "beat";
}

function pause(timing: HeartbeatTiming, failures: number): number {
  if (failures === 0) return timing.intervalMilliseconds;
  return Math.min(
    timing.firstBackoffMilliseconds * 2 ** (failures - 1),
    timing.longestBackoffMilliseconds,
  );
}

export async function runHeartbeats(
  context: HeartbeatContext,
  signal: AbortSignal,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    const outcome = await heartbeat(context, signal).catch(
      (): BeatOutcome => "failed",
    );
    failures = outcome === "failed" ? failures + 1 : 0;
    await context.wait(pause(context.timing, failures), signal);
  }
}
