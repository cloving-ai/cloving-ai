import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleIntents, execute, rebuild } from "../src/authority/reducer.ts";
import { admit, lastState, recorded, run } from "./authority-fixture.ts";

await test("CLV-006 a run moves through explicit waiting and terminal transitions", () => {
  const results = run([
    admit,
    {
      kind: "mark-started",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
    {
      kind: "open-gate",
      commandId: "c-3",
      runId: "run-1",
      gateId: "gate-1",
      expectedRevision: 2,
    },
    {
      kind: "decide-gate",
      commandId: "c-4",
      runId: "run-1",
      gateId: "gate-1",
      decision: "approved",
      expectedRevision: 3,
    },
    {
      kind: "complete-run",
      commandId: "c-5",
      runId: "run-1",
      expectedRevision: 4,
    },
  ]);
  assert.deepEqual(
    results.map((result) => result.kind),
    ["accepted", "accepted", "accepted", "accepted", "accepted"],
  );
  const events = results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.created",
      "run.started",
      "gate.opened",
      "gate.decided",
      "run.completed",
    ],
  );
  const state = lastState(results);
  const completed = state.runs["run-1"];
  assert.ok(completed);
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 5);
  assert.deepEqual(completed.gates, []);
  assert.deepEqual(state.intents, []);
  assert.deepEqual(rebuild(events), state);
});

await test("CLV-006 pause and resume return the run to the state it paused from", () => {
  const state = lastState(
    run([
      admit,
      {
        kind: "mark-started",
        commandId: "c-2",
        runId: "run-1",
        expectedRevision: 1,
      },
      {
        kind: "open-gate",
        commandId: "c-3",
        runId: "run-1",
        gateId: "gate-1",
        expectedRevision: 2,
      },
      {
        kind: "pause-run",
        commandId: "c-4",
        runId: "run-1",
        expectedRevision: 3,
      },
    ]),
  );
  const paused = state.runs["run-1"];
  assert.ok(paused);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedFrom, "waiting_gate");
  const resumed = execute(state, {
    command: {
      kind: "resume-run",
      commandId: "c-5",
      runId: "run-1",
      expectedRevision: 4,
    },
    ...recorded,
  });
  assert.equal(resumed.kind, "accepted");
  const waiting = resumed.state.runs["run-1"];
  assert.ok(waiting);
  assert.equal(waiting.status, "waiting_gate");
  assert.equal(waiting.pausedFrom, null);
});

await test("CLV-006 cancellation revokes unsent intents and the cancelled run accepts no further transitions", () => {
  const results = run([
    admit,
    {
      kind: "cancel-run",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
    {
      kind: "mark-started",
      commandId: "c-3",
      runId: "run-1",
      expectedRevision: 2,
    },
  ]);
  assert.deepEqual(
    results.map((result) => result.kind),
    ["accepted", "accepted", "rejected"],
  );
  assert.deepEqual(results[2], { kind: "rejected", reason: "terminal-run" });
  const state = lastState(results);
  assert.equal(state.runs["run-1"]?.status, "cancelled");
  assert.deepEqual(state.intents, []);
});

await test("CLV-006 stale, unknown and invalid transitions are rejected visibly", () => {
  for (const [command, reason] of [
    [
      {
        kind: "mark-started",
        commandId: "c-2",
        runId: "run-1",
        expectedRevision: 7,
      },
      "stale-revision",
    ],
    [
      {
        kind: "mark-started",
        commandId: "c-2",
        runId: "run-9",
        expectedRevision: 1,
      },
      "unknown-run",
    ],
    [
      {
        kind: "complete-run",
        commandId: "c-2",
        runId: "run-1",
        expectedRevision: 1,
      },
      "invalid-transition",
    ],
    [
      {
        kind: "resume-run",
        commandId: "c-2",
        runId: "run-1",
        expectedRevision: 1,
      },
      "invalid-transition",
    ],
    [
      {
        kind: "launch-anything",
        commandId: "c-2",
        runId: "run-1",
        expectedRevision: 1,
      },
      "invalid-command",
    ],
  ] as const)
    assert.deepEqual(run([admit, command])[1], { kind: "rejected", reason });
});

await test("CLV-006 deciding a gate the run is not waiting for is rejected", () => {
  const results = run([
    admit,
    {
      kind: "mark-started",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
    {
      kind: "open-gate",
      commandId: "c-3",
      runId: "run-1",
      gateId: "gate-1",
      expectedRevision: 2,
    },
    {
      kind: "decide-gate",
      commandId: "c-4",
      runId: "run-1",
      gateId: "gate-9",
      decision: "approved",
      expectedRevision: 3,
    },
  ]);
  assert.deepEqual(results[3], { kind: "rejected", reason: "unknown-gate" });
});

await test("CLV-006 rebuilding from an invalid event sequence fails visibly", () => {
  const results = run([
    admit,
    {
      kind: "mark-started",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
  ]);
  const events = results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  const [created, started] = events;
  assert.ok(created && started);
  assert.throws(() => rebuild([started]), /invalid-event/);
  assert.throws(
    () => rebuild([created, { ...started, sequence: 5 }]),
    /invalid-event/,
  );
  assert.throws(() => rebuild([created, started, started]), /invalid-event/);
});

await test("CLV-006 a failed run is terminal", () => {
  const results = run([
    admit,
    {
      kind: "mark-started",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
    { kind: "fail-run", commandId: "c-3", runId: "run-1", expectedRevision: 2 },
    {
      kind: "complete-run",
      commandId: "c-4",
      runId: "run-1",
      expectedRevision: 3,
    },
  ]);
  assert.deepEqual(
    results.map((result) => result.kind),
    ["accepted", "accepted", "accepted", "rejected"],
  );
  assert.equal(lastState(results).runs["run-1"]?.status, "failed");
  assert.deepEqual(results[3], { kind: "rejected", reason: "terminal-run" });
});

await test("CLV-006 deciding one of two open gates keeps the run waiting", () => {
  const state = lastState(
    run([
      admit,
      {
        kind: "mark-started",
        commandId: "c-2",
        runId: "run-1",
        expectedRevision: 1,
      },
      {
        kind: "open-gate",
        commandId: "c-3",
        runId: "run-1",
        gateId: "gate-1",
        expectedRevision: 2,
      },
      {
        kind: "open-gate",
        commandId: "c-4",
        runId: "run-1",
        gateId: "gate-2",
        expectedRevision: 3,
      },
      {
        kind: "decide-gate",
        commandId: "c-5",
        runId: "run-1",
        gateId: "gate-1",
        decision: "approved",
        expectedRevision: 4,
      },
    ]),
  );
  const waiting = state.runs["run-1"];
  assert.ok(waiting);
  assert.equal(waiting.status, "waiting_gate");
  assert.deepEqual(waiting.gates, ["gate-2"]);
});

await test("CLV-006 terminal transitions release the run's pending intents", () => {
  for (const ending of ["fail-run", "cancel-run"]) {
    const state = lastState(
      run([
        admit,
        { kind: ending, commandId: "c-2", runId: "run-1", expectedRevision: 1 },
      ]),
    );
    assert.deepEqual(state.intents, []);
  }
});

await test("CLV-006 a paused run keeps its intents but none is eligible until it resumes", () => {
  const paused = lastState(
    run([
      admit,
      {
        kind: "pause-run",
        commandId: "c-2",
        runId: "run-1",
        expectedRevision: 1,
      },
    ]),
  );
  assert.equal(paused.intents.length, 1);
  assert.deepEqual(eligibleIntents(paused), []);
  const resumed = execute(paused, {
    command: {
      kind: "resume-run",
      commandId: "c-3",
      runId: "run-1",
      expectedRevision: 2,
    },
    ...recorded,
  });
  assert.equal(resumed.kind, "accepted");
  assert.deepEqual(eligibleIntents(resumed.state), resumed.state.intents);
  assert.equal(resumed.state.intents.length, 1);
});

await test("CLV-006 a gate that is already open cannot be opened again", () => {
  const results = run([
    admit,
    {
      kind: "mark-started",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
    {
      kind: "open-gate",
      commandId: "c-3",
      runId: "run-1",
      gateId: "gate-1",
      expectedRevision: 2,
    },
    {
      kind: "open-gate",
      commandId: "c-4",
      runId: "run-1",
      gateId: "gate-1",
      expectedRevision: 3,
    },
  ]);
  assert.deepEqual(results[3], { kind: "rejected", reason: "existing-gate" });
});

await test("CLV-006 rebuilding rejects malformed events as invalid", () => {
  const results = run([admit]);
  const [created] = results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  assert.ok(created);
  for (const event of [
    { ...created, type: "run.exploded" },
    { ...created, runId: 5 },
    { ...created, payload: { workflow: 1 } },
    null,
  ])
    assert.throws(() => rebuild([event]), /invalid-event/);
});
