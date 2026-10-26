import { createPrivateKey, verify } from "node:crypto";
import { record } from "../src/protocol.ts";
import type { DaemonKeys } from "../src/relay/daemon-keys.ts";
import {
  envelopeAad,
  relayInfo,
  unpadPlaintext,
  type EnvelopeKind,
} from "../src/relay/envelope.ts";
import { openFrom } from "../src/relay/hpke.ts";
import { publicKeyObject } from "../src/relay/pairing-checks.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };

export function pkcs8(privateScalar: string, publicPoint: string): string {
  const point = Buffer.from(publicPoint, "base64url");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: privateScalar,
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  })
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
}

export const fixtureDaemonKeys: DaemonKeys = {
  agreementPrivateKey: pkcs8(
    fixture.daemon.agreementPrivateKey,
    fixture.daemon.agreementPublicKey,
  ),
  agreementPublicKey: fixture.daemon.agreementPublicKey,
  signingPrivateKey: pkcs8(
    fixture.daemon.signingPrivateKey,
    fixture.daemon.signingPublicKey,
  ),
  signingPublicKey: fixture.daemon.signingPublicKey,
};

export const fixtureDevice = {
  deviceId: fixture.device.id,
  agreementPrivateKey: pkcs8(
    fixture.device.agreementPrivateKey,
    fixture.device.agreementPublicKey,
  ),
  agreementPublicKey: fixture.device.agreementPublicKey,
};

export interface SealedEnvelope {
  readonly daemonId: string;
  readonly deviceId: string;
  readonly kind: EnvelopeKind;
  readonly sealed: Buffer;
}

export interface OpenedEnvelope {
  readonly payload: string;
  readonly signature: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly paddedBytes: number;
}

function text(value: unknown, name: string): string {
  const field: unknown = Reflect.get(Object(value), name);
  return typeof field === "string" ? field : "";
}

export function openedEnvelope(
  devicePrivateKey: string,
  sealed: SealedEnvelope,
): OpenedEnvelope {
  const padded = openFrom(devicePrivateKey, {
    info: relayInfo,
    aad: envelopeAad(sealed),
    sealed: sealed.sealed,
  });
  const message: unknown = JSON.parse(unpadPlaintext(padded).toString("utf8"));
  const payload = text(message, "payload");
  return {
    payload,
    signature: text(message, "signature"),
    fields: record(JSON.parse(payload)) ?? {},
    paddedBytes: padded.length,
  };
}

export function verifiedBy(
  signingPublicKey: string,
  message: { readonly payload: string; readonly signature: string },
): boolean {
  const key = publicKeyObject(signingPublicKey);
  if (key === undefined) return false;
  return verify(
    "sha256",
    Buffer.from(message.payload),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(message.signature, "base64url"),
  );
}
