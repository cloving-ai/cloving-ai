import assert from "node:assert/strict";
import { createECDH, createPrivateKey, decapsulate } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../src/phone/canonical-json.ts";
import {
  fullEnvelope,
  previewEnvelope,
} from "../src/relay/decision-envelopes.ts";
import { envelopeAad } from "../src/relay/envelope.ts";
import vectors from "./fixtures/phone-envelopes.json" with { type: "json" };
import {
  fixtureDevice,
  openedEnvelope,
  verifiedBy,
} from "./phone-envelope-fixture.ts";

const deviceKey = createPrivateKey({
  key: Buffer.from(fixtureDevice.agreementPrivateKey, "base64url"),
  format: "der",
  type: "pkcs8",
});

await test("CLV-191 the shared vectors open with the device key, verify with the daemon key and match the envelope codec", () => {
  assert.equal(vectors.device.id, fixtureDevice.deviceId);
  assert.deepEqual(
    vectors.envelopes.map((vector) => vector.kind),
    ["preview", "full"],
  );
  for (const vector of vectors.envelopes) {
    const kind = vector.kind === "preview" ? "preview" : "full";
    const ephemeral = createECDH("prime256v1");
    ephemeral.setPrivateKey(
      Buffer.from(vector.ephemeralPrivateKey, "base64url"),
    );
    assert.equal(ephemeral.getPublicKey().toString("base64url"), vector.enc);
    assert.equal(
      decapsulate(deviceKey, Buffer.from(vector.enc, "base64url")).toString(
        "base64url",
      ),
      vector.sharedSecret,
    );
    const binding = {
      daemonId: vectors.daemon.id,
      deviceId: vectors.device.id,
      kind,
    } as const;
    assert.equal(envelopeAad(binding).toString("utf8"), vector.aad);
    const opened = openedEnvelope(fixtureDevice.agreementPrivateKey, {
      ...binding,
      sealed: Buffer.from(vector.sealed, "base64url"),
    });
    assert.equal(opened.payload, vector.payload);
    assert.equal(opened.signature, vector.signature);
    assert.equal(opened.paddedBytes, vector.paddedBytes);
    assert.ok(verifiedBy(vectors.daemon.signingPublicKey, opened));
    const build = kind === "preview" ? previewEnvelope : fullEnvelope;
    const built = build({
      decision: vectors.decision,
      workflowId: vectors.workflowId,
      target: { ...vectors.target, sequence: vector.sequence },
    });
    assert.equal(canonicalJson(built), vector.payload);
  }
});
