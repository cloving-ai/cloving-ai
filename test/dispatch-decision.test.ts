import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dispatchDecision,
  type DispatchRead,
} from "../src/authority/dispatch-decision.ts";

const noon = "2026-10-10T12:00:00.000Z";
const later = "2026-10-10T12:10:00.000Z";

const read: DispatchRead = {
  attempt: { outcome: null, inputDigest: "digest-1", leaseGeneration: 2 },
  released: false,
  runStatus: "running",
  workflow: "pin-1",
  pinned: true,
  operation: {
    status: "dispatch-pending",
    capability: "fake-harness",
    units: 1,
  },
  budget: {
    limit: 2,
    spent: 1,
    capabilities: ["fake-harness"],
    exhaustedSequence: null,
  },
  lease: {
    operationId: "operation-1",
    generation: 2,
    expiresAt: later,
    state: "held",
  },
};

const intent = {
  operationId: "operation-1",
  inputDigest: "digest-1",
  computedDigest: "digest-1",
  workflow: "pin-1",
  leaseGeneration: 2,
};

await test("CLV-182 retry requires a current lease, pin, budget and running source", () => {
  const { operation, lease, budget } = read;
  assert.ok(operation);
  assert.ok(lease);
  assert.ok(budget);
  const recovering = {
    ...read,
    operation: { ...operation, status: "recovering" },
  };
  const check = { intent, now: noon, mode: "retry" as const };
  assert.equal(dispatchDecision(recovering, check), "send");
  for (const changed of [
    { ...recovering, lease: { ...lease, expiresAt: noon } },
    { ...recovering, runStatus: "cancelled" },
    { ...recovering, pinned: false },
    { ...recovering, budget: { ...budget, exhaustedSequence: 1 } },
    { ...recovering, lease: { ...lease, generation: 3 } },
  ])
    assert.notEqual(dispatchDecision(changed, check), "send");
  assert.equal(dispatchDecision(recovering, { intent, now: noon }), "withheld");
});

await test("CLV-049 the dispatch decision is send for an open attempt of the present lease generation in a running run before the lease expiry", () => {
  assert.equal(dispatchDecision(read, { intent, now: noon }), "send");
  const { budget } = read;
  assert.ok(budget);
  assert.equal(
    dispatchDecision(
      { ...read, budget: { ...budget, limit: 1 } },
      { intent, now: noon },
    ),
    "send",
  );
});

await test("CLV-049 the dispatch decision is stale for an attempt that is absent or closed, a different digest, a different pin, a retired lease generation or a different owner", () => {
  const { attempt, lease } = read;
  assert.ok(attempt);
  assert.ok(lease);
  for (const [name, changed] of Object.entries({
    absent: { ...read, attempt: undefined },
    closed: { ...read, attempt: { ...attempt, outcome: "accepted" } },
    stored: { ...read, attempt: { ...attempt, inputDigest: "digest-2" } },
    pin: { ...read, workflow: "pin-2" },
    retired: { ...read, attempt: { ...attempt, leaseGeneration: 1 } },
    start: { ...read, attempt: { ...attempt, leaseGeneration: null } },
    lease: { ...read, lease: undefined },
    owner: { ...read, lease: { ...lease, operationId: "operation-2" } },
    free: { ...read, lease: { ...lease, state: "released" } },
    record: { ...read, operation: undefined },
  }))
    assert.equal(
      dispatchDecision(changed, { intent, now: noon }),
      "stale",
      name,
    );
  for (const [name, changed] of Object.entries({
    computed: { ...intent, computedDigest: "digest-2" },
    argument: { ...intent, leaseGeneration: 1 },
  }))
    assert.equal(
      dispatchDecision(read, { intent: changed, now: noon }),
      "stale",
      name,
    );
});

await test("CLV-049 the dispatch decision is withheld for a released intent, a run that is not running, an operation that is not dispatch-pending and a lease at or after its expiry", () => {
  const { lease, operation } = read;
  assert.ok(lease);
  assert.ok(operation);
  for (const [name, changed] of Object.entries({
    released: { ...read, released: true },
    paused: { ...read, runStatus: "paused" },
    cancelled: { ...read, runStatus: "cancelled" },
    waiting: { ...read, operation: { ...operation, status: "waiting" } },
    recovering: { ...read, operation: { ...operation, status: "recovering" } },
    expired: { ...read, lease: { ...lease, state: "expired" } },
  }))
    assert.equal(
      dispatchDecision(changed, { intent, now: noon }),
      "withheld",
      name,
    );
  for (const now of [later, "2026-10-10T12:10:00.001Z", "not an instant"])
    assert.equal(dispatchDecision(read, { intent, now }), "withheld", now);
});

await test("CLV-049 the dispatch decision is refused when the budget of the run is exhausted, has no room for the units of the operation or does not name its capability", () => {
  const { budget, operation } = read;
  assert.ok(budget);
  assert.ok(operation);
  for (const [name, changed] of Object.entries({
    exhausted: { ...read, budget: { ...budget, exhaustedSequence: 9 } },
    above: { ...read, budget: { ...budget, limit: 0 } },
    units: { ...read, operation: { ...operation, units: 3 } },
    capability: { ...read, operation: { ...operation, capability: "network" } },
    absent: { ...read, budget: undefined },
  }))
    assert.equal(
      dispatchDecision(changed, { intent, now: noon }),
      "refused",
      name,
    );
  assert.equal(
    dispatchDecision(
      { ...read, runStatus: "paused", budget: { ...budget, limit: 0 } },
      { intent, now: noon },
    ),
    "withheld",
  );
});

await test("CLV-049 the dispatch decision is blocked when the available manifest does not agree with the pin, after the withheld and the refused decisions", () => {
  const { budget } = read;
  assert.ok(budget);
  const unpinned = { ...read, pinned: false };
  assert.deepEqual(
    [
      dispatchDecision(unpinned, { intent, now: noon }),
      dispatchDecision(
        { ...unpinned, runStatus: "paused" },
        { intent, now: noon },
      ),
      dispatchDecision(
        { ...unpinned, budget: { ...budget, exhaustedSequence: 9 } },
        { intent, now: noon },
      ),
      dispatchDecision(
        { ...unpinned, workflow: "pin-2" },
        { intent, now: noon },
      ),
    ],
    ["blocked", "withheld", "refused", "stale"],
  );
});
