import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandWaitRow } from "../src/storage/command-wait-rows.ts";
import type { GateRow } from "../src/storage/decision-rows.ts";
import type { ProjectionSnapshot } from "../src/storage/decision-snapshots.ts";
import type { DomainChange } from "../src/storage/domain-changes.ts";
import { changedProjection } from "../src/storage/projection-changes.ts";

const empty: ProjectionSnapshot = {
  definitions: [],
  runs: [],
  commands: [],
  outbox: [],
  gates: [],
  details: [],
  waits: [],
  deliveries: [],
  pending: [],
  sequence: 4,
};

const unchanged: DomainChange = {
  previous: 4,
  sequence: 4,
  definitions: [],
  events: [],
  runs: [],
  commands: [],
  added: [],
  released: [],
  staged: [],
  closed: [],
  gates: [],
  waits: [],
  details: [],
  documents: [],
  budgets: [],
  operations: [],
  leases: [],
  evidence: [],
  stops: [],
  completesAdoption: false,
};

function wait(fields: {
  readonly runId: string;
  readonly name: string;
  readonly state?: string;
}): CommandWaitRow {
  return {
    command: "npm test",
    inputDigest: `sha256:${"1".repeat(64)}`,
    maximumWaitSeconds: 60,
    pollEverySeconds: 5,
    startedAt: 1,
    deadline: 61,
    nextCheckAt: null,
    state: "waiting",
    checkCount: 0,
    checkOperation: null,
    lastCheckSettledAt: null,
    result: null,
    settledAt: null,
    reason: null,
    ...fields,
  };
}

function gate(fields: {
  readonly runId: string;
  readonly gateId: string;
}): GateRow {
  return {
    kind: "approval",
    label: null,
    subject: null,
    prompt: null,
    expiresAt: null,
    generation: 1,
    revision: 1,
    wait: "registered",
    decision: null,
    answer: null,
    decidedSequence: null,
    openedSequence: 3,
    continuation: null,
    ...fields,
  };
}

await test("CLV-276 a change upserts command waits and gates in the order of the table reads", () => {
  const first = changedProjection(empty, {
    ...unchanged,
    waits: [
      wait({ runId: "run-1", name: "b" }),
      wait({ runId: "run-1", name: "a" }),
      wait({ runId: "run-0", name: "z" }),
    ],
    gates: [
      gate({ runId: "run-2", gateId: "gate-2" }),
      gate({ runId: "run-1", gateId: "gate-1" }),
    ],
  });
  const second = changedProjection(first, {
    ...unchanged,
    waits: [wait({ runId: "run-1", name: "a", state: "passed" })],
  });
  assert.deepEqual(
    second.waits.map((row) => [row.runId, row.name, row.state]),
    [
      ["run-0", "z", "waiting"],
      ["run-1", "a", "passed"],
      ["run-1", "b", "waiting"],
    ],
  );
  assert.deepEqual(
    second.gates.map((row) => row.gateId),
    ["gate-1", "gate-2"],
  );
});

await test("CLV-276 a change keeps the first release and the first outcome of a row, as the guarded table updates do", () => {
  const staged = changedProjection(empty, {
    ...unchanged,
    previous: 4,
    sequence: 5,
    added: [
      {
        operationId: "op-1",
        kind: "start-run",
        runId: "run-1",
        createdSequence: 5,
      },
    ],
    staged: [
      {
        effectId: "effect-1",
        operationId: "op-1",
        inputDigest: "digest-1",
        purpose: "dispatch",
        leaseGeneration: null,
        authorityEpoch: 1,
      },
    ],
  });
  const settled = changedProjection(staged, {
    ...unchanged,
    previous: 5,
    sequence: 5,
    released: [
      { operationId: "op-1", releasedSequence: 5 },
      { operationId: "op-1", releasedSequence: 9 },
    ],
    closed: [
      { effectId: "effect-1", outcome: "sent", receipt: "receipt-1" },
      { effectId: "effect-1", outcome: "failed", receipt: null },
    ],
  });
  assert.deepEqual(
    settled.outbox.map((row) => row.releasedSequence),
    [5],
  );
  assert.deepEqual(
    settled.deliveries.map((row) => [row.stagedSequence, row.outcome]),
    [[5, "sent"]],
  );
});
