import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleIntents, rebuild } from "../src/authority/reducer.ts";
import {
  admit,
  answeredGate,
  continuation,
  dispatch,
  lastState,
  run,
} from "./authority-fixture.ts";

await test("CLV-007 an answered gate leaves exactly one eligible continuation for the run", () => {
  assert.deepEqual(eligibleIntents(lastState(run(answeredGate))), [
    continuation,
  ]);
});

await test("CLV-007 rebuilding rejects an event that its recorded request does not produce", () => {
  const results = run([
    admit,
    {
      kind: "mark-started",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
  ]);
  const [created, started] = results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  assert.ok(created && started);
  assert.deepEqual(rebuild([created, started]), lastState(results));
  for (const events of [
    [{ ...created, payload: { workflow: "pin-9" } }],
    [{ ...created, runId: "run-9" }],
    [created, { ...started, type: "run.completed" }],
    [{ ...created, request: "{" }],
  ])
    assert.throws(() => rebuild(events), /invalid-event: \d+ request-mismatch/);
});

await test("CLV-007 a recorded dispatch releases exactly its pending intent and cannot be recorded twice", () => {
  const results = run([
    ...answeredGate,
    dispatch,
    { ...dispatch, commandId: "c-6" },
    { ...dispatch, commandId: "c-7", operationId: "unknown-operation" },
    { ...dispatch, commandId: "c-8", runId: "run-2" },
  ]);
  const state = lastState(results);
  assert.equal(state.sequence, 5);
  const dispatchedRun = state.runs["run-1"];
  assert.deepEqual(
    [dispatchedRun?.status, dispatchedRun?.revision],
    ["running", 4],
  );
  assert.deepEqual(eligibleIntents(state), []);
  assert.deepEqual(results.slice(5), [
    { kind: "rejected", reason: "unknown-intent" },
    { kind: "rejected", reason: "unknown-intent" },
    { kind: "rejected", reason: "unknown-run" },
  ]);
  const events = results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  assert.deepEqual(events.at(-1)?.payload, {
    operationId: continuation.operationId,
    receipt: "wrun-1",
  });
  assert.equal(events.at(-1)?.type, "step.dispatched");
  assert.deepEqual(rebuild(events), state);
});

const reopenedGate = [
  ...answeredGate,
  {
    kind: "open-gate",
    commandId: "c-5",
    runId: "run-1",
    gateId: "gate-1",
    expectedRevision: 4,
  },
  {
    kind: "decide-gate",
    commandId: "c-6",
    runId: "run-1",
    gateId: "gate-1",
    decision: "approved",
    expectedRevision: 5,
  },
];

await test("CLV-007 a gate decided again after it reopens grants a distinct continuation that a dispatch of the first does not release", () => {
  const second = {
    ...continuation,
    operationId:
      '["cloving-operation",6,"run-1","gate","continue-run",null,"gate-1"]',
  };
  const results = run(reopenedGate);
  assert.deepEqual(eligibleIntents(lastState(results)), [continuation, second]);
  const dispatched = run([...reopenedGate, { ...dispatch, commandId: "c-7" }]);
  assert.equal(dispatched.at(-1)?.kind, "accepted");
  assert.deepEqual(eligibleIntents(lastState(dispatched)), [second]);
});
