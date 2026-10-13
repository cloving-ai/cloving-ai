import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { reconcile } from "../src/authority/reconciliation.ts";
import { admit, lastState, run } from "./authority-fixture.ts";

const startOperation =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';
const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const dispatchCommand = `dispatch:${digest(startOperation)}`;
const admitted = lastState(run([admit]));
const dispatched = lastState(
  run([
    admit,
    {
      kind: "record-dispatch",
      commandId: dispatchCommand,
      runId: "run-1",
      operationId: startOperation,
      receipt: "wrun-1",
    },
  ]),
);
const running = lastState(
  run([
    admit,
    {
      kind: "mark-started",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
  ]),
);

await test("CLV-042 an eligible start without a world run produces nothing, because native delivery owns the send", () => {
  assert.deepEqual(reconcile(admitted, []), {
    commands: [],
    conflicts: [],
    reports: [],
  });
});

await test("CLV-042 a world run found for an unrecorded start produces no command until its delivery records the dispatch", () => {
  for (const status of ["pending", "running", "completed", "failed"])
    assert.deepEqual(
      reconcile(admitted, [{ runId: "run-1", receipt: "wrun-1", status }]),
      { commands: [], conflicts: [], reports: [] },
    );
});

const failedPlan = [
  {
    kind: "report-observation",
    commandId: "observe:world-run-failed:wrun-1",
    runId: "run-1",
    condition: "infrastructure-failure",
    reason: "world-run-failed",
    evidence: "world-run:wrun-1",
  },
  {
    kind: "fail-run",
    commandId: "fail-run:wrun-1",
    runId: "run-1",
    expectedRevision: 1,
  },
];

await test("CLV-007 world progress after a recorded dispatch becomes the next run transition", () => {
  const steps = [
    [dispatched, "pending", []],
    [
      dispatched,
      "running",
      [
        {
          kind: "mark-started",
          commandId: "mark-started:wrun-1",
          runId: "run-1",
          expectedRevision: 1,
        },
      ],
    ],
    [
      dispatched,
      "completed",
      [
        {
          kind: "mark-started",
          commandId: "mark-started:wrun-1",
          runId: "run-1",
          expectedRevision: 1,
        },
      ],
    ],
    [dispatched, "failed", failedPlan],
    [
      running,
      "completed",
      [
        {
          kind: "complete-run",
          commandId: "complete-run:wrun-1",
          runId: "run-1",
          expectedRevision: 2,
        },
      ],
    ],
    [running, "running", []],
  ] as const;
  for (const [state, status, commands] of steps)
    assert.deepEqual(
      reconcile(state, [{ runId: "run-1", receipt: "wrun-1", status }]),
      { commands, conflicts: [], reports: [] },
    );
});

await test("CLV-007 two world runs for one Cloving run are reported and get no run transition", () => {
  assert.deepEqual(
    reconcile(admitted, [
      { runId: "run-1", receipt: "wrun-1", status: "pending" },
      { runId: "run-1", receipt: "wrun-2", status: "running" },
      { runId: "run-9", receipt: "wrun-9", status: "running" },
    ]),
    {
      commands: [
        {
          kind: "report-observation",
          commandId: "observe:world-run-conflict:wrun-1",
          runId: "run-1",
          condition: "infrastructure-failure",
          reason: "world-run-conflict",
          evidence: "world-run:wrun-1/world-run:wrun-2",
        },
      ],
      conflicts: ["run-1"],
      reports: [
        { kind: "unknown-world-run", runId: "run-9", receipt: "wrun-9" },
      ],
    },
  );
});
