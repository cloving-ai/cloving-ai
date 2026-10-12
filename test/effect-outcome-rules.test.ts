import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admission,
  applied,
  appliedAt,
  grant,
  later,
  noon,
  operation,
  operationOf,
  outcome,
  rejection,
  report,
  request,
  running,
  started,
} from "./effect-pure-fixture.ts";

const waiting = applied([
  { ...admission, effectLimit: 8 },
  started,
  request(1, { resource: "repository" }),
  request(2, { resource: "repository" }),
]).state;

await test("CLV-049 a rejected outcome of an operation that holds no lease counts no attempt and changes no status", () => {
  const unknown = [1, 2, 3].map((count) =>
    outcome(2, {
      outcome: "unknown",
      reason: "time-limit",
      commandId: `c-unknown-${String(count)}`,
    }),
  );
  const { state, last } = applied(unknown, waiting);
  const subject = operation(state, 2);
  assert.deepEqual(last.disposition, {
    operationId: operationOf(2),
    disposition: "rejected",
    reason: "retired-lease-generation",
  });
  assert.deepEqual(
    [subject.status, subject.reason, subject.attempts, state.effects.holding],
    ["waiting", "ready", 0, 0],
  );
  assert.deepEqual(state.effects.operations, waiting.effects.operations);
});

const stopReport = (operationId: string) => ({
  kind: "report-observation",
  runId: "run-1",
  commandId: "c-stop",
  condition: "stopped",
  reason: "worker-exit",
  operationId,
});

const named = (round: number, name: string): string =>
  JSON.stringify([
    "cloving-operation",
    round,
    "run-1",
    "work",
    name,
    null,
    null,
  ]);

await test("CLV-049 only a start or a continuation gets an entry in the stops: a stop report or a stopped outcome with a different operation name adds none", () => {
  const base = applied(running).state;
  for (const operationId of [operationOf(9), named(9, "launch-worker")]) {
    const { state } = applied([stopReport(operationId)], base);
    assert.deepEqual(state.effects.stops, {}, operationId);
    assert.equal(
      rejection(base, {
        kind: "record-outcome",
        runId: "run-1",
        commandId: "c-outcome-stop",
        operationId,
        outcome: "stopped",
      }),
      "unknown-operation",
      operationId,
    );
  }
  for (const name of ["start-run", "continue-run"]) {
    const { state } = applied([stopReport(named(4, name))], base);
    assert.deepEqual(Object.keys(state.effects.stops), [named(4, name)], name);
  }
});

await test("CLV-049 a report after the expiry event of its lease is rejected, also when its recorded time is before the expiry time", () => {
  const expired = appliedAt(later, {
    steps: [
      {
        kind: "expire-lease",
        runId: "run-1",
        commandId: "c-expire",
        operationId: operationOf(1),
        leaseGeneration: 1,
      },
    ],
    start: applied(running).state,
  }).state;
  const early = appliedAt(noon, { steps: [report(1)], start: expired });
  assert.deepEqual(early.last.disposition, {
    operationId: operationOf(1),
    disposition: "rejected",
    reason: "lease-expired",
  });
  assert.equal(operation(early.state).status, "recovering");
});

await test("CLV-049 a new operation for a resource whose lease is released waits with the reason ready", () => {
  const shared = { resource: "repository" };
  const released = applied([
    { ...admission, effectLimit: 8 },
    started,
    request(1, shared),
    grant({ round: 1, generation: 1 }),
    outcome(1, { outcome: "stopped" }),
  ]).state;
  assert.equal(released.effects.leases["repository"]?.state, "released");
  const next = operation(applied([request(2, shared)], released).state, 2);
  assert.deepEqual([next.status, next.reason], ["waiting", "ready"]);
});

for (const kind of ["complete-run", "fail-run", "cancel-run"])
  await test(`CLV-049 the terminal run event of ${kind} releases the protected intents of the run`, () => {
    const pending = applied([
      admission,
      started,
      request(1),
      grant({ round: 1, generation: 1 }),
    ]).state;
    assert.deepEqual(
      pending.intents.map((intent) => intent.kind),
      ["protected-effect"],
    );
    const ended = applied(
      [{ kind, runId: "run-1", commandId: "c-end", expectedRevision: 2 }],
      pending,
    ).state;
    assert.deepEqual(ended.intents, []);
  });
