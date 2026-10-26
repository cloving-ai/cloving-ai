import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  fullEnvelope,
  previewEnvelope,
} from "../src/relay/decision-envelopes.ts";
import { plaintextBytes, sealEnvelope } from "../src/relay/envelope.ts";
import { fixtureDaemonKeys, fixtureDevice } from "./phone-envelope-fixture.ts";

const decision = {
  decisionId: "run-1/review-1",
  label: null,
  type: "approval",
  runId: "run-1",
  gateId: "review-1",
  prompt: "Approve the merge of the pull request?",
  allowed: ["approve", "deny"],
  revision: 4,
  generation: 2,
  subjectDigest: `sha256:${"a".repeat(64)}`,
  openedAt: "2026-10-25T11:59:00.000Z",
  expiresAt: null,
  context: [],
  feedback: [],
};

const target = {
  daemonId: "dmn_fixture01",
  deviceId: fixtureDevice.deviceId,
  sequence: 7,
  issuedAt: "2026-10-25T12:00:00.000Z",
  expiresAt: "2026-11-01T11:00:00.000Z",
};

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

await test("CLV-191 the preview and the full envelope carry the decision fields of the design", () => {
  const source = { decision, workflowId: "develop-ticket", target };
  assert.deepEqual(previewEnvelope(source), {
    version: 1,
    kind: "preview",
    ...target,
    body: {
      decisionId: "run-1/review-1",
      label: null,
      type: "approval",
      workflowId: "develop-ticket",
      expiresAt: null,
      prompt: decision.prompt,
      truncated: false,
    },
  });
  assert.deepEqual(fullEnvelope(source), {
    version: 1,
    kind: "full",
    ...target,
    body: {
      decisionId: "run-1/review-1",
      label: null,
      type: "approval",
      runId: "run-1",
      workflowId: "develop-ticket",
      prompt: decision.prompt,
      allowed: ["approve", "deny"],
      revision: 4,
      generation: 2,
      subjectDigest: decision.subjectDigest,
      promptDigest: digest(decision.prompt),
      expiresAt: null,
      truncated: false,
    },
  });
});

await test("CLV-191 a private analysis question has the fixed text in the preview and the full prompt in the full envelope", () => {
  const source = {
    decision: { ...decision, type: "question", allowed: ["answer"] },
    workflowId: "analyze-chats",
    target,
  };
  assert.equal(
    previewEnvelope(source).body["prompt"],
    "Private analysis question. Run cloving questions to view it.",
  );
  assert.equal(fullEnvelope(source).body["prompt"], decision.prompt);
});

await test("CLV-191 a long prompt is cut at a character boundary to fit the preview and the largest envelope", () => {
  const prompt = `${"é".repeat(20_000)}${"😀".repeat(10_000)}`;
  const source = {
    decision: { ...decision, prompt },
    workflowId: "develop-ticket",
    target,
  };
  const preview = previewEnvelope(source);
  assert.ok(plaintextBytes(preview) <= 2048);
  assert.ok(plaintextBytes(preview) > 1900);
  assert.equal(preview.body["truncated"], true);
  const shown = String(preview.body["prompt"]);
  assert.ok(prompt.startsWith(shown));
  assert.ok(shown.length > 0);
  const full = fullEnvelope(source);
  assert.ok(plaintextBytes(full) < 65_536);
  assert.ok(plaintextBytes(full) > 65_000);
  assert.equal(full.body["truncated"], true);
  assert.ok(prompt.startsWith(String(full.body["prompt"])));
  assert.equal(full.body["promptDigest"], digest(prompt));
  const sealed = sealEnvelope(fixtureDaemonKeys, {
    agreementPublicKey: fixtureDevice.agreementPublicKey,
    envelope: full,
  });
  assert.equal(sealed.length, 65 + 65_536 + 16);
});
