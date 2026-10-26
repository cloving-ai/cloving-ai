import assert from "node:assert/strict";
import { test } from "node:test";
import {
  padPlaintext,
  sealEnvelope,
  unpadPlaintext,
  type Envelope,
} from "../src/relay/envelope.ts";
import {
  fixtureDaemonKeys,
  fixtureDevice,
  openedEnvelope,
  verifiedBy,
} from "./phone-envelope-fixture.ts";

const envelope: Envelope = {
  version: 1,
  kind: "full",
  daemonId: "dmn_fixture01",
  deviceId: fixtureDevice.deviceId,
  sequence: 3,
  issuedAt: "2026-10-25T12:00:00.000Z",
  expiresAt: "2026-11-01T11:00:00.000Z",
  body: { decisionId: "run-1/review-1", prompt: "Approve the merge?" },
};

function sealed(kind: Envelope["kind"]): Buffer {
  return sealEnvelope(fixtureDaemonKeys, {
    agreementPublicKey: fixtureDevice.agreementPublicKey,
    envelope: { ...envelope, kind },
  });
}

await test("CLV-191 a sealed envelope opens with the device key and carries the fields that the daemon signed", () => {
  const sealedText = sealed("full");
  assert.equal(sealedText.length, 65 + 1024 + 16);
  const opened = openedEnvelope(fixtureDevice.agreementPrivateKey, {
    daemonId: envelope.daemonId,
    deviceId: envelope.deviceId,
    kind: "full",
    sealed: sealedText,
  });
  assert.deepEqual(opened.fields, envelope);
  assert.equal(opened.paddedBytes, 1024);
  assert.equal(verifiedBy(fixtureDaemonKeys.signingPublicKey, opened), true);
});

await test("CLV-191 a changed payload or a changed signature fails the daemon signature check", () => {
  const opened = openedEnvelope(fixtureDevice.agreementPrivateKey, {
    daemonId: envelope.daemonId,
    deviceId: envelope.deviceId,
    kind: "full",
    sealed: sealed("full"),
  });
  const signature = Buffer.from(opened.signature, "base64url");
  signature[10] = (signature[10] ?? 0) ^ 1;
  assert.equal(
    verifiedBy(fixtureDaemonKeys.signingPublicKey, {
      payload: opened.payload,
      signature: signature.toString("base64url"),
    }),
    false,
  );
  assert.equal(
    verifiedBy(fixtureDaemonKeys.signingPublicKey, {
      payload: opened.payload.replace('"sequence":3', '"sequence":4'),
      signature: opened.signature,
    }),
    false,
  );
});

await test("CLV-191 the associated data binds the daemon, the device and the kind", () => {
  const sealedText = sealed("preview");
  for (const other of [
    { daemonId: "dmn_other", deviceId: envelope.deviceId, kind: "preview" },
    { daemonId: envelope.daemonId, deviceId: "phone-2", kind: "preview" },
    { daemonId: envelope.daemonId, deviceId: envelope.deviceId, kind: "full" },
  ] as const)
    assert.throws(
      () =>
        openedEnvelope(fixtureDevice.agreementPrivateKey, {
          ...other,
          sealed: sealedText,
        }),
      Error,
      JSON.stringify(other),
    );
});

await test("CLV-191 a padded plaintext has 1, 4, 16 or 64 KiB, and a plaintext over the largest size is refused", () => {
  for (const [length, size] of [
    [0, 1024],
    [1023, 1024],
    [1024, 4096],
    [4095, 4096],
    [4096, 16_384],
    [16_383, 16_384],
    [16_384, 65_536],
    [65_535, 65_536],
  ] as const) {
    const plaintext = Buffer.alloc(length, 0x7b);
    const padded = padPlaintext(plaintext);
    assert.equal(padded.length, size, String(length));
    assert.deepEqual(unpadPlaintext(padded), plaintext);
  }
  assert.throws(() => padPlaintext(Buffer.alloc(65_536, 0x7b)), {
    message: /^envelope-too-large: /,
  });
  assert.throws(() => unpadPlaintext(Buffer.alloc(1024)), {
    message: /^envelope-padding-invalid: /,
  });
});
