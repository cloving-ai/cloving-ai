import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "../phone/canonical-json.ts";
import type { DaemonKeys } from "./daemon-keys.ts";

export interface PairingRequest {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly agreementPublicKey: string;
  readonly answerPublicKey: string;
  readonly approvalPublicKey: string;
  readonly code: string;
}

export type RequestCheck =
  | { readonly kind: "valid"; readonly request: PairingRequest }
  | { readonly kind: "refused"; readonly code: string };

export interface SignedMessage {
  readonly payload: string;
  readonly signature: string;
}

const requestFields = [
  "agreement_public_key",
  "answer_public_key",
  "approval_public_key",
  "device_id",
  "name",
  "platform",
] as const;

type RequestFields = Readonly<
  Record<(typeof requestFields)[number] | "mac", string>
>;

function text(value: unknown, name: string): string | undefined {
  const field: unknown =
    typeof value === "object" && value !== null
      ? Reflect.get(value, name)
      : undefined;
  return typeof field === "string" ? field : undefined;
}

export function publicKeyObject(point: string): KeyObject | undefined {
  const raw = Buffer.from(point, "base64url");
  if (raw.length !== 65 || raw[0] !== 4 || raw.toString("base64url") !== point)
    return undefined;
  try {
    return createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    return undefined;
  }
}

function requestFieldsOf(body: unknown): RequestFields | undefined {
  const agreement = text(body, "agreement_public_key");
  const answer = text(body, "answer_public_key");
  const approval = text(body, "approval_public_key");
  const deviceId = text(body, "device_id");
  const name = text(body, "name");
  const platform = text(body, "platform");
  const mac = text(body, "mac");
  if (
    agreement === undefined ||
    answer === undefined ||
    approval === undefined ||
    deviceId === undefined ||
    name === undefined ||
    platform === undefined ||
    mac === undefined
  )
    return undefined;
  return {
    agreement_public_key: agreement,
    answer_public_key: answer,
    approval_public_key: approval,
    device_id: deviceId,
    name,
    platform,
    mac,
  };
}

export function pairingCode(secret: Buffer, canonical: string): string {
  const digest = createHash("sha256").update(canonical).digest();
  const tag = createHmac("sha256", secret)
    .update("cloving-pair-code|")
    .update(digest)
    .digest();
  const number = BigInt(`0x${tag.toString("hex")}`) % 1_000_000n;
  return String(number).padStart(6, "0");
}

function macValid(secret: Buffer, given: RequestFields): string {
  const canonical = canonicalJson(
    Object.fromEntries(requestFields.map((name) => [name, given[name]])),
  );
  const expected = createHmac("sha256", secret).update(canonical).digest();
  const mac = Buffer.from(given.mac, "base64url");
  const valid =
    mac.length === expected.length && timingSafeEqual(mac, expected);
  return valid ? canonical : "";
}

function wellFormed(given: RequestFields): boolean {
  return (
    /^[A-Za-z0-9_-]{1,64}$/.test(given.device_id) &&
    Array.from(given.name).length <= 64 &&
    ["ios", "android"].includes(given.platform)
  );
}

export function checkedRequest(secret: Buffer, body: unknown): RequestCheck {
  const given = requestFieldsOf(body);
  if (given === undefined)
    return { kind: "refused", code: "pairing-request-invalid" };
  const canonical = macValid(secret, given);
  if (canonical === "") return { kind: "refused", code: "pairing-mac-invalid" };
  const keys = [
    given.agreement_public_key,
    given.answer_public_key,
    given.approval_public_key,
  ];
  if (keys.some((key) => publicKeyObject(key) === undefined))
    return { kind: "refused", code: "pairing-key-invalid" };
  if (!wellFormed(given))
    return { kind: "refused", code: "pairing-request-invalid" };
  return {
    kind: "valid",
    request: {
      deviceId: given.device_id,
      name: given.name,
      platform: given.platform,
      agreementPublicKey: given.agreement_public_key,
      answerPublicKey: given.answer_public_key,
      approvalPublicKey: given.approval_public_key,
      code: pairingCode(secret, canonical),
    },
  };
}

export function signedReceipt(
  keys: DaemonKeys,
  values: {
    readonly daemonId: string;
    readonly deviceId: string;
    readonly pairedAt: string;
  },
): { readonly receipt: SignedMessage; readonly nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const payload = canonicalJson({
    daemonId: values.daemonId,
    deviceId: values.deviceId,
    kind: "pairing-receipt",
    nonce,
    pairedAt: values.pairedAt,
    version: 1,
  });
  return { receipt: signedBy(keys, payload), nonce };
}

export function signedBy(keys: DaemonKeys, payload: string): SignedMessage {
  const key = createPrivateKey({
    key: Buffer.from(keys.signingPrivateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign("sha256", Buffer.from(payload), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return { payload, signature: signature.toString("base64url") };
}

export interface ExpectedCheck {
  readonly daemonId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly answerPublicKey: string;
  readonly now: number;
}

function signatureValid(message: SignedMessage, publicKey: string): boolean {
  const key = publicKeyObject(publicKey);
  return (
    key !== undefined &&
    verify(
      "sha256",
      Buffer.from(message.payload),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(message.signature, "base64url"),
    )
  );
}

function checkFields(payload: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null) return {};
    return canonicalJson(value) === payload ? { ...value } : {};
  } catch {
    return {};
  }
}

export function checkValid(check: unknown, expected: ExpectedCheck): boolean {
  const payload = text(check, "payload");
  const signature = text(check, "signature");
  if (payload === undefined || signature === undefined) return false;
  if (!signatureValid({ payload, signature }, expected.answerPublicKey))
    return false;
  const fields = checkFields(payload);
  const wanted: Readonly<Record<string, unknown>> = {
    daemonId: expected.daemonId,
    deviceId: expected.deviceId,
    kind: "pairing-check",
    nonce: expected.nonce,
    signedAt: fields["signedAt"],
    version: 1,
  };
  const signedAt = Date.parse(String(fields["signedAt"]));
  return (
    typeof fields["signedAt"] === "string" &&
    canonicalJson(wanted) === payload &&
    Math.abs(signedAt - expected.now) <= 600_000
  );
}
