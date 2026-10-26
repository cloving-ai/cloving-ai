import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedRequest, checkValid } from "../src/relay/pairing-checks.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };
import { phoneRequestBody, signedByAnswerKey } from "./phone-fake-phone.ts";

await test("CLV-189 the request checks refuse missing fields, long names and other platforms", () => {
  const secret = Buffer.from(fixture.secret, "base64url");
  const link = fixture.link;
  assert.deepEqual(checkedRequest(secret, null), {
    kind: "refused",
    code: "pairing-request-invalid",
  });
  assert.deepEqual(checkedRequest(secret, { device_id: "x" }), {
    kind: "refused",
    code: "pairing-request-invalid",
  });
  for (const values of [{ name: "n".repeat(65) }, { platform: "windows" }])
    assert.deepEqual(checkedRequest(secret, phoneRequestBody(link, values)), {
      kind: "refused",
      code: "pairing-request-invalid",
    });
  assert.deepEqual(
    checkedRequest(secret, phoneRequestBody(link, { mac: "short" })),
    {
      kind: "refused",
      code: "pairing-mac-invalid",
    },
  );
  const valid = checkedRequest(secret, {
    ...fixture.request,
    mac: fixture.mac,
  });
  assert.equal(valid.kind === "valid" ? valid.request.code : "", fixture.code);
});

await test("CLV-189 the check refuses a missing field, another key, an old time and another device", () => {
  const expected = {
    daemonId: fixture.daemon.id,
    deviceId: fixture.device.id,
    nonce: fixture.receiptNonce,
    answerPublicKey: fixture.device.answerPublicKey,
    now: Date.parse(fixture.checkSignedAt),
  };
  assert.equal(checkValid(fixture.check, expected), true);
  assert.equal(checkValid({ payload: fixture.check.payload }, expected), false);
  assert.equal(
    checkValid(fixture.check, {
      ...expected,
      answerPublicKey: fixture.device.approvalPublicKey,
    }),
    false,
  );
  assert.equal(
    checkValid(fixture.check, { ...expected, answerPublicKey: "bad" }),
    false,
  );
  assert.equal(
    checkValid(fixture.check, { ...expected, now: expected.now + 3_600_000 }),
    false,
  );
  assert.equal(
    checkValid(fixture.check, { ...expected, deviceId: "other" }),
    false,
  );
});

await test("CLV-189 a signed check with a broken payload is refused as invalid", () => {
  const expected = {
    daemonId: fixture.daemon.id,
    deviceId: fixture.device.id,
    nonce: fixture.receiptNonce,
    answerPublicKey: fixture.device.answerPublicKey,
    now: Date.parse(fixture.checkSignedAt),
  };
  for (const payload of ["not json", '{"daemonId":"x"}', "[]"])
    assert.equal(
      checkValid(signedByAnswerKey(payload), expected),
      false,
      payload,
    );
});
