import assert from "node:assert/strict";
import { test } from "node:test";
import { operationRecords } from "../src/broker/actor/authority-session.ts";

await test("CLV-136 operation snapshots visit deliveries once as operation count grows", () => {
  let visits = 0;
  const outbox = Array.from({ length: 128 }, (_, index) => ({
    operationId: `operation-${String(index)}`,
    kind: "start-run",
    runId: `run-${String(index)}`,
    createdSequence: index,
    releasedSequence: null,
  }));
  const deliveries = outbox.map((row) => ({
    get operationId() {
      visits++;
      return row.operationId;
    },
    effectId: `effect-${row.operationId}`,
    inputDigest: "digest",
    stagedSequence: row.createdSequence,
    outcome: null,
    receipt: null,
    purpose: "dispatch",
    leaseGeneration: null,
    epoch: 1,
  }));
  const records = operationRecords({ outbox, deliveries });
  assert.equal(visits, deliveries.length);
  assert.equal(records.length, outbox.length);
  assert.deepEqual(records[1], {
    operationId: "operation-1",
    kind: "start-run",
    runId: "run-1",
    createdSequence: 1,
    releasedSequence: null,
    deliveries: [
      {
        effectId: "effect-operation-1",
        outcome: null,
        receipt: null,
        purpose: "dispatch",
        epoch: 1,
      },
    ],
  });
});
