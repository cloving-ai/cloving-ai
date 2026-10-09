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

await test("CLV-007 an eligible start without a world run is sent and nothing is recorded", () => {
  assert.deepEqual(reconcile(admitted, [], digest), {
    send: [{ kind: "start-run", runId: "run-1", operationId: startOperation }],
    commands: [],
    conflicts: [],
  });
});

await test("CLV-007 a world run found for an unrecorded start records its receipt instead of sending again", () => {
  assert.deepEqual(
    reconcile(
      admitted,
      [{ runId: "run-1", receipt: "wrun-1", status: "pending" }],
      digest,
    ),
    {
      send: [],
      commands: [
        {
          kind: "record-dispatch",
          commandId: dispatchCommand,
          runId: "run-1",
          operationId: startOperation,
          receipt: "wrun-1",
        },
      ],
      conflicts: [],
    },
  );
});

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
    [
      dispatched,
      "failed",
      [
        {
          kind: "fail-run",
          commandId: "fail-run:wrun-1",
          runId: "run-1",
          expectedRevision: 1,
        },
      ],
    ],
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
      reconcile(state, [{ runId: "run-1", receipt: "wrun-1", status }], digest),
      { send: [], commands, conflicts: [] },
    );
});

await test("CLV-007 two world runs for one Cloving run are reported and never reconciled", () => {
  assert.deepEqual(
    reconcile(
      admitted,
      [
        { runId: "run-1", receipt: "wrun-1", status: "pending" },
        { runId: "run-1", receipt: "wrun-2", status: "running" },
        { runId: "run-9", receipt: "wrun-9", status: "running" },
      ],
      digest,
    ),
    { send: [], commands: [], conflicts: ["run-1"] },
  );
});
