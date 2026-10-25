import assert from "node:assert/strict";
import { createHmac, createPrivateKey, sign } from "node:crypto";
import { canonicalJson } from "../src/phone/canonical-json.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };
import type { FakeRelayServer } from "./phone-relay-server-fixture.ts";

export interface PhoneRequestValues {
  readonly deviceId?: string;
  readonly name?: string;
  readonly platform?: string;
  readonly answerPublicKey?: string;
  readonly mac?: string;
}

export function linkSecret(link: string): Buffer {
  const payload = Buffer.from(link.split("#v1.")[1] ?? "", "base64url");
  assert.equal(payload.length, 32);
  return payload.subarray(0, 16);
}

export function phoneRequestBody(
  link: string,
  values: PhoneRequestValues = {},
): Record<string, string> {
  const request = {
    agreement_public_key: fixture.device.agreementPublicKey,
    answer_public_key: values.answerPublicKey ?? fixture.device.answerPublicKey,
    approval_public_key: fixture.device.approvalPublicKey,
    device_id: values.deviceId ?? fixture.device.id,
    name: values.name ?? "Pixel 8a",
    platform: values.platform ?? "android",
  };
  const mac = createHmac("sha256", linkSecret(link))
    .update(canonicalJson(request))
    .digest("base64url");
  return { ...request, mac: values.mac ?? mac };
}

export function sendPhoneRequest(
  server: FakeRelayServer,
  exchange: { readonly link: string; readonly values?: PhoneRequestValues },
): string {
  const [pairingId] = [...server.pairings.keys()].slice(-1);
  assert.ok(pairingId !== undefined);
  server.change(pairingId, {
    stage: "requested",
    request: phoneRequestBody(exchange.link, exchange.values),
  });
  return pairingId;
}

function answerKey() {
  const point = Buffer.from(fixture.device.answerPublicKey, "base64url");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: fixture.device.answerPrivateKey,
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
}

export function receiptFields(
  server: FakeRelayServer,
  pairingId: string,
): Readonly<Record<string, unknown>> {
  const receipt: unknown = server.pairings.get(pairingId)?.receipt;
  const payload: unknown = Reflect.get(Object(receipt), "payload");
  assert.equal(typeof payload, "string");
  const fields: unknown = JSON.parse(String(payload));
  assert.ok(typeof fields === "object" && fields !== null);
  return { ...fields };
}

export function sendPhoneCheck(
  server: FakeRelayServer,
  exchange: {
    readonly pairingId: string;
    readonly nonce?: string;
    readonly signer?: "answer" | "wrong";
  },
): void {
  const receipt = receiptFields(server, exchange.pairingId);
  const payload = canonicalJson({
    daemonId: receipt["daemonId"],
    deviceId: receipt["deviceId"],
    kind: "pairing-check",
    nonce: exchange.nonce ?? receipt["nonce"],
    signedAt: new Date().toISOString(),
    version: 1,
  });
  const signature = sign("sha256", Buffer.from(payload), {
    key: answerKey(),
    dsaEncoding: "ieee-p1363",
  });
  if (exchange.signer === "wrong") signature[10] = (signature[10] ?? 0) ^ 0xff;
  server.change(exchange.pairingId, {
    stage: "checked",
    check: { payload, signature: signature.toString("base64url") },
  });
}
