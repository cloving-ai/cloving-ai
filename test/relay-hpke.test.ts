import assert from "node:assert/strict";
import { createPrivateKey, decapsulate } from "node:crypto";
import { test } from "node:test";
import {
  keySchedule,
  openFrom,
  openAt,
  sealAt,
  sealTo,
} from "../src/relay/hpke.ts";
import fixture from "./fixtures/hpke-cfrg-p256-sha256-aes256gcm.json" with { type: "json" };

function hex(name: string): Buffer {
  const value: unknown = Reflect.get(fixture.vector, name);
  return Buffer.from(typeof value === "string" ? value : "", "hex");
}

function recipientKey(): string {
  const point = hex("pkRm");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: hex("skRm").toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  })
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
}

const first = fixture.encryptions[0];

await test("CLV-191 the CFRG vector gives the shared secret, the key, the base nonce and the sealed texts", () => {
  const privateKey = createPrivateKey({
    key: Buffer.from(recipientKey(), "base64url"),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(
    decapsulate(privateKey, hex("enc")).toString("hex"),
    fixture.vector["shared_secret"],
  );
  const schedule = keySchedule(hex("shared_secret"), hex("info"));
  assert.equal(schedule.key.toString("hex"), fixture.vector["key"]);
  assert.equal(
    schedule.baseNonce.toString("hex"),
    fixture.vector["base_nonce"],
  );
  for (const encryption of fixture.encryptions) {
    const message = {
      sequence: encryption.sequence,
      aad: Buffer.from(encryption.aad, "hex"),
    };
    assert.equal(
      sealAt(schedule, {
        ...message,
        plaintext: Buffer.from(encryption.pt, "hex"),
      }).toString("hex"),
      encryption.ct,
      String(encryption.sequence),
    );
    assert.equal(
      openAt(schedule, {
        ...message,
        ciphertext: Buffer.from(encryption.ct, "hex"),
      }).toString("hex"),
      encryption.pt,
    );
  }
});

await test("CLV-191 the recipient key opens the sealed text of the vector, and a sealed text opens with its key", () => {
  assert.ok(first);
  const sealed = Buffer.concat([hex("enc"), Buffer.from(first.ct, "hex")]);
  const message = { info: hex("info"), aad: Buffer.from(first.aad, "hex") };
  assert.equal(
    openFrom(recipientKey(), { ...message, sealed }).toString("hex"),
    first.pt,
  );
  const plaintext = Buffer.from("A question for the phone.");
  const own = sealTo(hex("pkRm").toString("base64url"), {
    ...message,
    plaintext,
  });
  assert.equal(own.length, 65 + plaintext.length + 16);
  assert.deepEqual(
    openFrom(recipientKey(), { ...message, sealed: own }),
    plaintext,
  );
});

await test("CLV-191 a changed byte in the encapsulated key, the ciphertext, the tag or the associated data makes open fail", () => {
  const message = {
    info: Buffer.from("cloving-relay-v1"),
    aad: Buffer.from("cloving-relay-v1|dmn_1|phone-1|full"),
  };
  const sealed = sealTo(hex("pkRm").toString("base64url"), {
    ...message,
    plaintext: Buffer.from("The full prompt."),
  });
  for (const index of [1, 64, 65, sealed.length - 1]) {
    const changed = Buffer.from(sealed);
    changed[index] = (changed[index] ?? 0) ^ 1;
    assert.throws(
      () => openFrom(recipientKey(), { ...message, sealed: changed }),
      Error,
      String(index),
    );
  }
  assert.throws(() =>
    openFrom(recipientKey(), {
      ...message,
      aad: Buffer.from("cloving-relay-v1|dmn_1|phone-2|full"),
      sealed,
    }),
  );
  assert.throws(() =>
    openFrom(recipientKey(), { ...message, sealed: sealed.subarray(0, 80) }),
  );
});

await test("CLV-191 sealing to a key that is not a P-256 point and opening a text shorter than its tag fail", () => {
  const message = {
    info: Buffer.from("cloving-relay-v1"),
    aad: Buffer.from("aad"),
  };
  assert.throws(
    () => sealTo("AAAA", { ...message, plaintext: Buffer.from("x") }),
    { message: /^hpke-seal-failed: / },
  );
  const schedule = keySchedule(hex("shared_secret"), hex("info"));
  assert.throws(
    () =>
      openAt(schedule, {
        sequence: 0,
        aad: Buffer.alloc(0),
        ciphertext: Buffer.alloc(15),
      }),
    { message: /^hpke-open-failed: / },
  );
});
