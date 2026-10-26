import { randomBytes } from "node:crypto";
import {
  record,
  type Fields,
  type Reply,
  type ServiceRequest,
} from "../protocol.ts";
import type { EnvelopeTarget } from "./decision-envelopes.ts";
import {
  collapseId,
  sealEnvelope,
  type Envelope,
  type EnvelopeKind,
} from "./envelope.ts";
import type { PostedEnvelope } from "./phone-delivery.ts";
import type { PhoneDevice } from "./phone-devices.ts";
import type { Registration } from "./relay-registration.ts";
import type { RelayStore } from "./relay-store.ts";

export interface CheckContext {
  readonly phoneDirectory: string;
  readonly store: RelayStore;
  readonly control: (request: ServiceRequest) => Promise<Reply>;
  readonly now: () => number;
}

export interface Sealing {
  readonly registration: Registration;
  readonly device: PhoneDevice;
  readonly decisionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly build: (target: EnvelopeTarget) => Envelope;
}

const pushes: Readonly<Record<EnvelopeKind, string>> = {
  preview: "alert",
  full: "none",
  closed: "passive",
};

const envelopeLifetimeMilliseconds = 7 * 86_400_000 - 3_600_000;

export function rows(value: unknown): readonly Fields[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const fields = record(item);
    return fields === undefined ? [] : [fields];
  });
}

export async function resultOf(
  context: CheckContext,
  request: ServiceRequest,
): Promise<Fields | undefined> {
  const reply = await context.control(request);
  return reply.kind === "result" ? reply.result : undefined;
}

export function envelopeExpiry(gateExpiry: unknown, issued: number): string {
  const limit = issued + envelopeLifetimeMilliseconds;
  const gate = Date.parse(String(gateExpiry));
  return new Date(
    Number.isNaN(gate) ? limit : Math.min(gate, limit),
  ).toISOString();
}

export async function sealedPost(
  context: CheckContext,
  sealing: Sealing,
): Promise<PostedEnvelope> {
  const { registration, device } = sealing;
  const envelope = sealing.build({
    daemonId: registration.link.daemonId,
    deviceId: device.deviceId,
    sequence: await context.store.nextSequence(device.deviceId),
    issuedAt: sealing.issuedAt,
    expiresAt: sealing.expiresAt,
  });
  const sealed = sealEnvelope(registration.keys, {
    envelope,
    agreementPublicKey: device.agreementPublicKey,
  });
  return {
    envelopeId: randomBytes(16).toString("base64url"),
    kind: envelope.kind,
    ciphertext: sealed.toString("base64url"),
    expiresAt: sealing.expiresAt,
    push: pushes[envelope.kind],
    collapseId:
      envelope.kind === "full"
        ? null
        : collapseId(registration.keys, sealing.decisionId),
  };
}
