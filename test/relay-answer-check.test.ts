import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerDecisionId,
  answerVerdict,
  type AnswerScope,
} from "../src/relay/answer-check.ts";
import type { PhoneDevice } from "../src/relay/phone-devices.ts";
import fixture from "./fixtures/phone-pairing.json" with { type: "json" };
import {
  answerBase,
  signedAnswer,
  textDigest,
  type AnswerFields,
} from "./phone-answer-fixture.ts";

const phone: PhoneDevice = {
  deviceId: fixture.device.id,
  name: "Phone",
  platform: "ios",
  agreementPublicKey: fixture.device.agreementPublicKey,
  answerPublicKey: fixture.device.answerPublicKey,
  approvalPublicKey: fixture.device.approvalPublicKey,
  pairedAt: "2026-10-25T12:00:00.000Z",
  state: "connected",
  removedAt: null,
};

const scope: AnswerScope = {
  daemonId: answerBase.daemonId,
  routedDeviceId: phone.deviceId,
  devices: [phone],
  now: Date.parse(answerBase.signedAt),
  sentPromptDigest: answerBase.promptDigest,
};

const approval = {
  ...answerBase,
  command: "approve",
  text: null,
  textDigest: null,
  keyClass: "approval",
};

function refusal(
  fields: AnswerFields,
  options: {
    readonly signer?: "answer" | "approval";
    readonly scope?: Partial<AnswerScope>;
  } = {},
): string {
  const verdict = answerVerdict(
    signedAnswer(fields, options.signer ?? "answer"),
    { ...scope, ...options.scope },
  );
  return verdict.kind === "refused" ? verdict.code : "accepted";
}

await test("CLV-193 a signed answer becomes a decision request with the command ID of the phone and its device actor", () => {
  const message = signedAnswer(answerBase, "answer");
  assert.equal(answerDecisionId(message), "run-1/review-1");
  assert.deepEqual(answerVerdict(message, scope), {
    kind: "decision",
    decisionId: "run-1/review-1",
    parameters: {
      command: "answer",
      reference: "run-1/review-1",
      text: "Use the table parser.",
      expectedRevision: 1,
      generation: 1,
      subjectDigest: answerBase.subjectDigest,
      commandId: "phone-c1",
      actor: `device:${phone.deviceId}`,
    },
  });
  assert.deepEqual(answerVerdict(signedAnswer(approval, "approval"), scope), {
    kind: "decision",
    decisionId: "run-1/review-1",
    parameters: {
      command: "approve",
      reference: "run-1/review-1",
      expectedRevision: 1,
      generation: 1,
      subjectDigest: answerBase.subjectDigest,
      commandId: "phone-c1",
      actor: `device:${phone.deviceId}`,
    },
  });
});

await test("CLV-193 an approval signed with the answer key needs the approval key", () => {
  assert.equal(
    refusal({ ...approval, keyClass: "answer" }),
    "approval-key-required",
  );
  assert.equal(
    refusal({ ...approval, command: "deny", keyClass: "answer" }),
    "approval-key-required",
  );
  assert.equal(refusal(approval), "signature-invalid");
});

await test("CLV-193 an unknown, removed or checking device is refused", () => {
  assert.equal(
    refusal(answerBase, { scope: { devices: [] } }),
    "device-unknown",
  );
  assert.equal(
    refusal(answerBase, {
      scope: { devices: [{ ...phone, removedAt: "2026-10-26T11:00:00Z" }] },
    }),
    "device-revoked",
  );
  assert.equal(
    refusal(answerBase, {
      scope: { devices: [{ ...phone, state: "checking" }] },
    }),
    "device-not-connected",
  );
});

await test("CLV-193 a wrong signature, an old answer, a changed prompt and a wrong text digest are refused", () => {
  const message = signedAnswer(answerBase, "answer");
  const signature = Buffer.from(message.signature, "base64url");
  signature[5] = (signature[5] ?? 0) ^ 1;
  const changed = answerVerdict(
    { ...message, signature: signature.toString("base64url") },
    scope,
  );
  assert.deepEqual(changed, {
    kind: "refused",
    code: "signature-invalid",
    decisionId: "run-1/review-1",
  });
  const minute = 60_000;
  assert.equal(
    refusal(answerBase, { scope: { now: scope.now + 11 * minute } }),
    "answer-too-old",
  );
  assert.equal(
    refusal(answerBase, { scope: { now: scope.now - 11 * minute } }),
    "answer-too-old",
  );
  assert.equal(
    refusal(answerBase, { scope: { now: scope.now + 9 * minute } }),
    "accepted",
  );
  assert.equal(
    refusal(answerBase, { scope: { sentPromptDigest: textDigest("Other?") } }),
    "prompt-changed",
  );
  assert.equal(
    refusal(answerBase, { scope: { sentPromptDigest: null } }),
    "prompt-changed",
  );
  assert.equal(
    refusal({ ...answerBase, textDigest: textDigest("Something else.") }),
    "answer-invalid",
  );
  assert.equal(
    refusal(
      { ...approval, textDigest: textDigest("x") },
      { signer: "approval" },
    ),
    "answer-invalid",
  );
});

await test("CLV-193 a malformed answer is refused before any other check", () => {
  for (const fields of [
    { ...answerBase, kind: "receipt" },
    { ...answerBase, version: 2 },
    { ...answerBase, daemonId: "dmn_other" },
    { ...answerBase, deviceId: "other-phone" },
    { ...answerBase, command: "drop" },
    { ...answerBase, keyClass: "root" },
    { ...answerBase, expectedRevision: 0 },
    { ...answerBase, generation: -1 },
    { ...answerBase, signedAt: "yesterday" },
    { ...answerBase, commandId: 7 },
  ])
    assert.equal(refusal(fields), "answer-invalid", JSON.stringify(fields));
  const broken = answerVerdict(
    { payload: "not json", signature: "AAAA" },
    scope,
  );
  assert.deepEqual(broken, {
    kind: "refused",
    code: "answer-invalid",
    decisionId: null,
  });
  assert.equal(answerDecisionId({ payload: "[]", signature: "" }), null);
});
