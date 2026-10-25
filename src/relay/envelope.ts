import { createHmac } from "node:crypto";
import { canonicalJson } from "../phone/canonical-json.ts";
import type { Fields } from "../protocol.ts";
import type { DaemonKeys } from "./daemon-keys.ts";
import { sealTo } from "./hpke.ts";
import { signedBy } from "./pairing-checks.ts";

export type EnvelopeKind = "preview" | "full" | "closed";

export interface Envelope {
  readonly version: 1;
  readonly kind: EnvelopeKind;
  readonly daemonId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly body: Fields;
}

export const relayInfo = Buffer.from("cloving-relay-v1");

const paddedSizes = [1024, 4096, 16_384, 65_536] as const;
const marker = 0x80;
const signatureCharacters = 86;

export function envelopeAad(binding: {
  readonly daemonId: string;
  readonly deviceId: string;
  readonly kind: string;
}): Buffer {
  return Buffer.from(
    `cloving-relay-v1|${binding.daemonId}|${binding.deviceId}|${binding.kind}`,
  );
}

export function collapseId(keys: DaemonKeys, decisionId: string): string {
  const key = createHmac(
    "sha256",
    Buffer.from(keys.signingPrivateKey, "base64url"),
  )
    .update("cloving-collapse-key")
    .digest();
  return createHmac("sha256", key)
    .update(decisionId)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

export function plaintextBytes(envelope: Envelope): number {
  return Buffer.byteLength(
    canonicalJson({
      payload: canonicalJson(envelope),
      signature: "A".repeat(signatureCharacters),
    }),
  );
}

export function signedPlaintext(keys: DaemonKeys, envelope: Envelope): Buffer {
  return Buffer.from(canonicalJson(signedBy(keys, canonicalJson(envelope))));
}

export function padPlaintext(plaintext: Buffer): Buffer {
  const size = paddedSizes.find((bytes) => plaintext.length < bytes);
  if (size === undefined)
    throw new Error(
      `envelope-too-large: A sealed envelope has at most ${String(paddedSizes.at(-1))} bytes.`,
    );
  const padded = Buffer.alloc(size);
  plaintext.copy(padded);
  padded[plaintext.length] = marker;
  return padded;
}

export function unpadPlaintext(padded: Buffer): Buffer {
  const end = padded.findLastIndex((byte) => byte !== 0);
  if (end === -1 || padded[end] !== marker)
    throw new Error("envelope-padding-invalid: The envelope has no end mark.");
  return padded.subarray(0, end);
}

export function sealEnvelope(
  keys: DaemonKeys,
  sealing: {
    readonly envelope: Envelope;
    readonly agreementPublicKey: string;
  },
): Buffer {
  const { envelope } = sealing;
  return sealTo(sealing.agreementPublicKey, {
    info: relayInfo,
    aad: envelopeAad(envelope),
    plaintext: padPlaintext(signedPlaintext(keys, envelope)),
  });
}
