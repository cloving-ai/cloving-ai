import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile, type WorldRun } from "../src/authority/reconciliation.ts";
import {
  emptyAuthority,
  execute,
  type AuthorityState,
} from "../src/authority/reducer.ts";
import { admit, lastState, recorded } from "./authority-fixture.ts";

const startOperation =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';
const unrevised = ["admit-run", "record-dispatch", "report-observation"];

function advanced(
  state: AuthorityState,
  commands: readonly Readonly<Record<string, unknown>>[],
): AuthorityState {
  let current = state;
  for (const [index, command] of commands.entries()) {
    const result = execute(current, {
      command: {
        commandId: `c-${String(current.sequence)}-${String(index)}`,
        runId: "run-1",
        ...(unrevised.includes(String(command["kind"]))
          ? {}
          : { expectedRevision: current.runs["run-1"]?.revision }),
        ...command,
      },
      ...recorded,
    });
    assert.equal(result.kind, "accepted", JSON.stringify(result));
    current = lastState([result]);
  }
  return current;
}

const queued = advanced(emptyAuthority, [
  admit,
  { kind: "record-dispatch", operationId: startOperation, receipt: "wrun-1" },
]);
const running = advanced(queued, [{ kind: "mark-started" }]);
const atGate = advanced(running, [{ kind: "open-gate", gateId: "gate-1" }]);
const paused = advanced(running, [{ kind: "pause-run" }]);
const decided = advanced(atGate, [
  { kind: "decide-gate", gateId: "gate-1", decision: "approved" },
]);

function world(status: string, outcome?: string): WorldRun[] {
  return [
    {
      runId: "run-1",
      receipt: "wrun-1",
      status,
      ...(outcome === undefined ? {} : { outcome }),
    },
  ];
}

function settled(
  state: AuthorityState,
  worldRuns: readonly WorldRun[],
): { readonly state: AuthorityState; readonly kinds: readonly string[] } {
  const kinds: string[] = [];
  let current = state;
  for (let pass = 0; pass < 5; pass += 1) {
    const plan = reconcile(current, worldRuns);
    if (plan.commands.length === 0) return { state: current, kinds };
    kinds.push(...plan.commands.map((command) => String(command["kind"])));
    current = advanced(current, plan.commands);
  }
  throw new Error("The reconciliation does not settle.");
}

function observation(state: AuthorityState): unknown {
  const last = state.details["run-1"]?.observation;
  return last && [last.condition, last.reason, last.evidence];
}

await test("CLV-056 the reconciliation reports a World run whose tag names an unknown Cloving run", () => {
  const plan = reconcile(running, [
    ...world("running"),
    { runId: "run-9", receipt: "wrun-9", status: "running" },
  ]);
  assert.deepEqual(plan.reports, [
    { kind: "unknown-world-run", runId: "run-9", receipt: "wrun-9" },
  ]);
  assert.deepEqual(plan.commands, []);
  assert.deepEqual(reconcile(running, world("running")).reports, []);
});

await test("CLV-056 a World failure while the run waits at a gate gives the recorded transition", () => {
  const result = settled(atGate, world("failed"));
  assert.deepEqual(result.kinds, ["report-observation", "fail-run"]);
  assert.equal(result.state.runs["run-1"]?.status, "failed");
  assert.deepEqual(observation(result.state), [
    "infrastructure-failure",
    "world-run-failed",
    "world-run:wrun-1",
  ]);
  for (const state of [queued, running])
    assert.equal(
      settled(state, world("failed")).state.runs["run-1"]?.status,
      "failed",
    );
});

await test("CLV-056 a World failure while the run is paused gives the recorded recovery state, and the transition after the resume", () => {
  const held = settled(paused, world("failed"));
  assert.deepEqual(held.kinds, ["report-observation"]);
  assert.equal(held.state.runs["run-1"]?.status, "paused");
  assert.deepEqual(observation(held.state), [
    "infrastructure-failure",
    "world-run-failed",
    "world-run:wrun-1",
  ]);
  const resumed = advanced(held.state, [{ kind: "resume-run" }]);
  const result = settled(resumed, world("failed"));
  assert.deepEqual(result.kinds, ["fail-run"]);
  assert.equal(result.state.runs["run-1"]?.status, "failed");
});

await test("CLV-056 a World cancellation in each run state gives the recorded transition", () => {
  for (const state of [queued, running, atGate]) {
    const result = settled(state, world("cancelled"));
    assert.deepEqual(result.kinds, ["report-observation", "fail-run"]);
    assert.equal(result.state.runs["run-1"]?.status, "failed");
    assert.deepEqual(observation(result.state), [
      "infrastructure-failure",
      "world-run-cancelled",
      "world-run:wrun-1",
    ]);
  }
  const held = settled(paused, world("cancelled"));
  assert.deepEqual(held.kinds, ["report-observation"]);
  assert.equal(held.state.runs["run-1"]?.status, "paused");
  const failed = settled(running, world("failed")).state;
  assert.deepEqual(reconcile(failed, world("cancelled")).commands, []);
});

await test("CLV-056 the end of a segment with the outcome waiting_for_decision does not complete the run, also when the decision comes before the reconciliation of the segment end", () => {
  for (const state of [running, atGate, decided, paused])
    assert.deepEqual(
      reconcile(state, world("completed", "waiting_for_decision")).commands,
      [],
    );
  assert.equal(decided.runs["run-1"]?.status, "running");
  const started = settled(queued, world("completed", "waiting_for_decision"));
  assert.deepEqual(started.kinds, ["mark-started"]);
  assert.equal(started.state.runs["run-1"]?.status, "running");
  for (const outcome of ["handoff_requested", undefined])
    assert.equal(
      settled(running, world("completed", outcome)).state.runs["run-1"]?.status,
      "completed",
    );
});

const continueOperation = String(
  decided.intents.find((intent) => intent.kind === "continue-run")?.operationId,
);

function segments(
  second: Partial<WorldRun> & { readonly status: string },
): WorldRun[] {
  return [
    {
      runId: "run-1",
      receipt: "wrun-1",
      status: "completed",
      outcome: "waiting_for_decision",
      operationId: startOperation,
      createdAt: "2026-10-13T10:00:00.000Z",
    },
    {
      runId: "run-1",
      receipt: "wrun-2",
      operationId: continueOperation,
      createdAt: "2026-10-13T10:00:01.000Z",
      ...second,
    },
  ];
}

await test("CLV-057 two World runs of one Cloving run with two operation IDs are no conflict, and the last segment gives the progress", () => {
  const continued = advanced(decided, [
    {
      kind: "record-dispatch",
      operationId: continueOperation,
      receipt: "wrun-2",
    },
  ]);
  assert.deepEqual(reconcile(continued, segments({ status: "running" })), {
    commands: [],
    conflicts: [],
    reports: [],
  });
  const ended = segments({ status: "completed", outcome: "handoff_requested" });
  assert.deepEqual(reconcile(continued, ended.toReversed()).commands, [
    {
      kind: "complete-run",
      commandId: "complete-run:wrun-2",
      runId: "run-1",
      expectedRevision: continued.runs["run-1"]?.revision,
    },
  ]);
  assert.deepEqual(reconcile(decided, ended).commands, []);
  const failed = settled(continued, segments({ status: "failed" }));
  assert.deepEqual(failed.kinds, ["report-observation", "fail-run"]);
  assert.deepEqual(observation(failed.state), [
    "infrastructure-failure",
    "world-run-failed",
    "world-run:wrun-2",
  ]);
});

await test("CLV-057 two World runs with one operation ID, or a second World run with no operation ID, are a conflict", () => {
  for (const operationId of [startOperation, null])
    assert.deepEqual(
      reconcile(running, segments({ status: "running", operationId })),
      { commands: [], conflicts: ["run-1"], reports: [] },
    );
});
