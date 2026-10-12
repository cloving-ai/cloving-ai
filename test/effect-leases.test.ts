import assert from "node:assert/strict";
import { test } from "node:test";
import { promotions } from "../src/authority/leases.ts";
import {
  accepted,
  admission,
  applied,
  appliedAt,
  grant,
  later,
  operation,
  operationOf,
  outcome,
  rejection,
  report,
  request,
  running,
  started,
} from "./effect-pure-fixture.ts";

const first = operationOf(1);
const pending = [
  admission,
  started,
  request(1),
  grant({ round: 1, generation: 1 }),
];

function expiry(round: number, generation: number): Record<string, unknown> {
  return {
    kind: "expire-lease",
    runId: "run-1",
    commandId: `c-expire-${String(round)}-${String(generation)}`,
    operationId: operationOf(round),
    leaseGeneration: generation,
  };
}

await test("CLV-049 a lease expiry is valid only for a held lease of that generation at or after its expiry time", () => {
  const held = applied(pending).state;
  assert.equal(rejection(held, expiry(1, 1)), "lease-not-expired");
  assert.equal(rejection(held, expiry(1, 2)), "stale-lease-generation");
  assert.equal(rejection(held, expiry(7, 1)), "unknown-operation");
  const waiting = applied([admission, started, request(1)]).state;
  assert.equal(rejection(waiting, expiry(1, 1)), "lease-not-held");
  const released = applied([...running, report(1)]).state;
  assert.equal(rejection(released, expiry(1, 1)), "lease-not-held");
  const expired = appliedAt(later, { steps: [expiry(1, 1)], start: held });
  assert.equal(expired.state.effects.leases[first]?.state, "expired");
  const again = { ...expiry(1, 1), commandId: "c-again" };
  assert.equal(rejection(expired.state, again), "lease-not-held");
});

await test("CLV-049 an expired lease makes an operation that is dispatch-pending or running recover, and the owner keeps the key and the capacity unit", () => {
  const shared = { resource: "repository" };
  for (const steps of [
    [
      admission,
      started,
      request(1, shared),
      grant({ round: 1, generation: 1 }),
    ],
    [
      admission,
      started,
      request(1, shared),
      grant({ round: 1, generation: 1 }),
      accepted(1),
    ],
  ]) {
    const held = applied([...steps, request(2, shared)]).state;
    const { state } = appliedAt(later, { steps: [expiry(1, 1)], start: held });
    const recovering = operation(state);
    assert.deepEqual(
      [recovering.status, recovering.reason, recovering.attempts],
      ["recovering", "lease-expired", 0],
    );
    assert.deepEqual(
      [state.effects.leases["repository"]?.operationId, state.effects.holding],
      [first, 1],
    );
    assert.equal(
      rejection(state, grant({ round: 2, generation: 2 })),
      "resource-held",
    );
  }
});

await test("CLV-049 an operation that recovers or is blocked keeps its status at a lease expiry, and an acceptance under an expired lease adds no attempt", () => {
  const unknown = (name: string) =>
    outcome(1, { outcome: "unknown", reason: "time-limit", commandId: name });
  const once = applied([...pending, unknown("c-u1")]).state;
  const kept = appliedAt(later, { steps: [expiry(1, 1)], start: once }).state;
  assert.deepEqual(
    [operation(kept).status, operation(kept).reason, operation(kept).attempts],
    ["recovering", "outcome-unknown", 1],
  );
  const blocked = applied([unknown("c-u2"), unknown("c-u3")], once).state;
  const still = appliedAt(later, { steps: [expiry(1, 1)], start: blocked });
  assert.equal(operation(still.state).status, "blocked");
  const late = appliedAt(later, {
    steps: [expiry(1, 1), accepted(1)],
    start: applied(pending).state,
  }).state;
  const alive = operation(late);
  assert.deepEqual(
    [alive.status, alive.reason, alive.attempts, alive.receipt, alive.worker],
    ["recovering", "lease-expired", 0, "receipt-1", "worker-1"],
  );
  assert.deepEqual(late.intents, []);
});

await test("CLV-049 each terminal run event cancels the waiting operations of the run and keeps each operation that holds a lease", () => {
  const second = { ...admission, commandId: "c-admit-2", runId: "run-2" };
  const other = { ...started, commandId: "c-start-2", runId: "run-2" };
  const foreign = request(5, {
    runId: "run-2",
    operationId: operationOf(5, "run-2"),
  });
  const base = applied([...running, request(2), second, other, foreign]).state;
  for (const kind of ["cancel-run", "fail-run", "complete-run"]) {
    const end = {
      kind,
      commandId: "c-end",
      runId: "run-1",
      expectedRevision: 2,
    };
    const { state } = applied([end], base);
    const waited = operation(state, 2);
    assert.deepEqual(
      [waited.status, waited.reason, waited.settledSequence],
      ["cancelled", "run-ended", base.sequence + 1],
      kind,
    );
    assert.equal(operation(state).status, "running", kind);
    assert.equal(
      state.effects.operations[operationOf(5, "run-2")]?.status,
      "waiting",
      kind,
    );
    assert.equal(state.effects.holding, 1, kind);
  }
});

const startOperation =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';

await test("CLV-049 a stop report or a stopped outcome adds a start or a continuation of its run to the stops, and a stop report never settles a protected operation", () => {
  const base = applied(running).state;
  const stopReport = (operationId: string, commandId: string) => ({
    kind: "report-observation",
    runId: "run-1",
    commandId,
    condition: "stopped",
    reason: "worker-exit",
    operationId,
  });
  const named = applied([stopReport(startOperation, "c-stop-1")], base).state;
  assert.deepEqual(named.effects.stops, {
    [startOperation]: { runId: "run-1", sequence: base.sequence + 1 },
  });
  const foreign = startOperation.replace("run-1", "run-2");
  for (const operationId of [foreign, first, "free text"]) {
    const { state } = applied([stopReport(operationId, "c-stop-2")], base);
    assert.deepEqual(state.effects, base.effects, operationId);
  }
  const working = {
    ...stopReport(startOperation, "c-work"),
    condition: "working",
  };
  assert.deepEqual(applied([working], base).state.effects.stops, {});
  const stopped = {
    kind: "record-outcome",
    runId: "run-1",
    commandId: "c-outcome-stop",
    operationId: startOperation,
    outcome: "stopped",
  };
  const confirmed = applied([stopped], base);
  assert.deepEqual(confirmed.state.effects.stops, {
    [startOperation]: { runId: "run-1", sequence: base.sequence + 1 },
  });
  assert.deepEqual(confirmed.last.disposition, {
    operationId: startOperation,
    disposition: "applied",
    reason: null,
  });
  assert.equal(
    rejection(base, { ...stopped, outcome: "completed" }),
    "unknown-operation",
  );
  assert.equal(
    rejection(base, { ...stopped, operationId: foreign }),
    "unknown-operation",
  );
});

await test("CLV-049 the promotion selects, below the capacity bound, the oldest waiting operation of each key with no owner in a running run", () => {
  const shared = { resource: "repository" };
  const second = { ...admission, commandId: "c-admit-2", runId: "run-2" };
  const foreign = request(9, {
    runId: "run-2",
    operationId: operationOf(9, "run-2"),
  });
  const state = applied([
    { ...admission, effectLimit: 8 },
    started,
    request(1, shared),
    request(2, shared),
    request(3),
    request(4),
    second,
    { ...started, commandId: "c-start-2", runId: "run-2" },
    foreign,
  ]).state;
  const ids = (bound: number): readonly string[] =>
    promotions(state, bound).map((operation) => operation.operationId);
  assert.deepEqual(ids(8), [
    operationOf(1),
    operationOf(3),
    operationOf(4),
    operationOf(9, "run-2"),
  ]);
  assert.deepEqual(ids(2), [operationOf(1), operationOf(3)]);
  assert.deepEqual(ids(0), []);
  const granted = applied([grant({ round: 1, generation: 1 })], state).state;
  assert.deepEqual(
    promotions(granted, 3).map((operation) => operation.operationId),
    [operationOf(3), operationOf(4)],
  );
  const pause = { kind: "pause-run", commandId: "c-pause", runId: "run-1" };
  const paused = applied([{ ...pause, expectedRevision: 2 }], granted).state;
  assert.deepEqual(
    promotions(paused, 8).map((operation) => operation.operationId),
    [operationOf(9, "run-2")],
  );
});
