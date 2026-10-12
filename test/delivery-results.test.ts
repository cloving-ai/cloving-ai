import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completedOutcome,
  thrownOutcome,
} from "../src/broker/actor/delivery-results.ts";

const noon = "2026-10-10T12:00:00.000Z";
const later = "2026-10-10T12:10:00.000Z";
const present = { epoch: 4, recordedAt: noon };
const identity = {
  effectId: "effect-1",
  operationId: "operation-1",
  inputDigest: `sha256:${"a".repeat(64)}`,
};
const intent = {
  operationId: identity.operationId,
  inputDigest: identity.inputDigest,
};
const thrown = {
  ...identity,
  outcome: "thrown",
  receipt: null,
  worker: null,
  result: null,
  reason: null,
  ...present,
};

await test("CLV-049 the callback reads a handler result of a known kind with its fields, its epoch and its time", () => {
  assert.deepEqual(
    completedOutcome(
      {
        effectId: "effect-1",
        arguments: intent,
        result: {
          kind: "completed",
          receipt: "receipt-1",
          worker: "worker-1",
          result: "the result",
          reason: null,
          epoch: 3,
          recordedAt: later,
        },
      },
      present,
    ),
    {
      ...identity,
      outcome: "completed",
      receipt: "receipt-1",
      worker: "worker-1",
      result: "the result",
      reason: null,
      epoch: 3,
      recordedAt: later,
    },
  );
});

await test("CLV-049 a handler result that the callback cannot read is the outcome of a thrown handler, with the epoch and the time of the actor", () => {
  const readable = { kind: "sent", receipt: "receipt-1", epoch: 3 };
  for (const result of [
    { ...readable, recordedAt: later, kind: "constructor" },
    { ...readable, recordedAt: later, kind: 7 },
    { receipt: "receipt-1", epoch: 3, recordedAt: later },
    { ...readable, recordedAt: later, epoch: "3" },
    { ...readable, recordedAt: later, receipt: 7 },
    readable,
    null,
  ])
    assert.deepEqual(
      completedOutcome(
        { effectId: "effect-1", arguments: intent, result },
        present,
      ),
      thrown,
      JSON.stringify(result),
    );
  assert.deepEqual(
    thrownOutcome({ effectId: "effect-1", arguments: intent }, present),
    thrown,
  );
});
