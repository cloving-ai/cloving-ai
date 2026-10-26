import { createHash, createPrivateKey, sign } from "node:crypto";
import { canonicalJson } from "../src/phone/canonical-json.ts";
import { envelopeAad, padPlaintext, relayInfo } from "../src/relay/envelope.ts";
import { sealTo } from "../src/relay/hpke.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };

export type AnswerFields = Readonly<Record<string, unknown>>;

export interface SignedAnswer {
  readonly payload: string;
  readonly signature: string;
}

export function textDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export const answerBase = {
  version: 1,
  kind: "answer",
  daemonId: "dmn_test1",
  deviceId: fixture.device.id,
  decisionId: "run-1/review-1",
  command: "answer",
  text: "Use the table parser.",
  textDigest: textDigest("Use the table parser."),
  expectedRevision: 1,
  generation: 1,
  subjectDigest: `sha256:${"a".repeat(64)}`,
  promptDigest: textDigest("Which parser?"),
  commandId: "phone-c1",
  signedAt: "2026-10-26T12:00:00.000Z",
  keyClass: "answer",
};

function phoneKey(signer: "answer" | "approval") {
  const publicKey =
    signer === "answer"
      ? fixture.device.answerPublicKey
      : fixture.device.approvalPublicKey;
  const point = Buffer.from(publicKey, "base64url");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d:
        signer === "answer"
          ? fixture.device.answerPrivateKey
          : fixture.device.approvalPrivateKey,
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
}

export function signedAnswer(
  fields: AnswerFields,
  signer: "answer" | "approval",
): SignedAnswer {
  const payload = canonicalJson(fields);
  const signature = sign("sha256", Buffer.from(payload), {
    key: phoneKey(signer),
    dsaEncoding: "ieee-p1363",
  });
  return { payload, signature: signature.toString("base64url") };
}

export function sealedAnswer(
  daemon: { readonly daemonId: string; readonly agreementPublicKey: string },
  answer: { readonly deviceId: string; readonly message: SignedAnswer },
): string {
  return sealTo(daemon.agreementPublicKey, {
    info: relayInfo,
    aad: envelopeAad({
      daemonId: daemon.daemonId,
      deviceId: answer.deviceId,
      kind: "answer",
    }),
    plaintext: padPlaintext(Buffer.from(canonicalJson(answer.message))),
  }).toString("base64url");
}
