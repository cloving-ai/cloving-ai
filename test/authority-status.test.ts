import assert from "node:assert/strict";
import { test } from "node:test";
import { runView, type StatusInput } from "../src/authority/status.ts";
import {
  gate,
  input,
  open,
  sent,
  start,
  unknown,
} from "./authority-status-fixture.ts";

const cases: readonly (readonly [
  string,
  StatusInput,
  readonly [string, string, string | null, boolean],
])[] = [
  [
    "queued",
    input({ status: "queued" }),
    ["queued", "awaiting-dispatch", "dispatch", false],
  ],
  [
    "queued with a delivery in progress",
    input({ status: "queued", operations: [open] }),
    ["queued", "dispatch-in-progress", null, false],
  ],
  [
    "working",
    input({ status: "running", observed: {}, operations: [sent] }),
    ["working", "progress", null, false],
  ],
  [
    "working with no observation",
    input({ status: "running", operations: [sent] }),
    ["working", "in-progress", null, false],
  ],
  [
    "silent work",
    input({ status: "running", observed: {}, silent: true }),
    ["working", "no-recent-observation", "reconcile-worker", false],
  ],
  [
    "quota wait",
    input({
      status: "running",
      observed: { condition: "quota-wait", reason: "provider-quota" },
      silent: true,
    }),
    ["quota-wait", "provider-quota", "recheck-eligibility", false],
  ],
  [
    "infrastructure failure",
    input({
      status: "running",
      observed: {
        condition: "infrastructure-failure",
        reason: "evidence-store-down",
        attempt: 1,
        limit: 3,
      },
    }),
    ["infrastructure-failure", "evidence-store-down", "retry-operation", false],
  ],
  [
    "infrastructure failure with no attempt left",
    input({
      status: "running",
      observed: {
        condition: "infrastructure-failure",
        reason: "evidence-store-down",
        attempt: 3,
        limit: 3,
      },
    }),
    ["infrastructure-failure", "evidence-store-down", null, true],
  ],
  [
    "code failure",
    input({
      status: "running",
      observed: { condition: "code-failure", reason: "tests-failed" },
    }),
    ["code-failure", "tests-failed", "repair-code", false],
  ],
  [
    "pending design decision",
    input({
      status: "waiting_gate",
      gates: [gate("question"), gate("approval")],
    }),
    ["waiting-decision", "design-question", "answer", true],
  ],
  [
    "pending policy decision",
    input({ status: "waiting_gate", gates: [gate("approval")] }),
    ["waiting-decision", "policy-approval", "approve-or-deny", true],
  ],
  [
    "uncertain effect",
    input({ status: "running", observed: {}, operations: [sent, unknown] }),
    ["uncertain-effect", "delivery-outcome-unknown", "reconcile-effect", true],
  ],
  [
    "blocked continuation",
    input({
      status: "running",
      observed: {},
      operations: [sent, { ...unknown, outcomes: ["blocked"] }],
    }),
    [
      "infrastructure-failure",
      "pinned-workflow-unavailable",
      "restore-pinned-workflow",
      true,
    ],
  ],
  [
    "paused",
    input({ status: "paused" }),
    ["paused", "operator-pause", "resume", true],
  ],
  [
    "cancelling with a delivery in flight",
    input({ status: "cancelled", operations: [open] }),
    ["cancelling", "delivery-in-flight", "reconcile-effect", false],
  ],
  [
    "cancelling with no observed stop",
    input({ status: "cancelled", observed: {}, operations: [sent] }),
    ["cancelling", "stop-not-observed", "observe-worker-stop", false],
  ],
  [
    "cancelled after an observed stop",
    input({
      status: "cancelled",
      observed: {
        condition: "stopped",
        reason: "worker-exit",
        operationId: start,
      },
      operations: [sent],
    }),
    ["cancelled", "run-cancelled", null, false],
  ],
  [
    "cancelled before a dispatch",
    input({
      status: "cancelled",
      operations: [{ ...sent, outcomes: ["withheld"] }],
    }),
    ["cancelled", "run-cancelled", null, false],
  ],
  [
    "completed",
    input({ status: "completed", operations: [sent] }),
    ["completed", "run-completed", null, false],
  ],
  [
    "failed",
    input({
      status: "failed",
      observed: { condition: "code-failure", reason: "tests-failed" },
    }),
    ["failed", "tests-failed", null, true],
  ],
];

for (const [title, given, expected] of cases)
  await test(`CLV-008 status gives a structured reason for: ${title}`, () => {
    const view = runView(given);
    assert.deepEqual(
      [
        view.condition,
        view.reason.code,
        view.nextAction,
        view.humanInputCanHelp,
      ],
      expected,
    );
    assert.equal(view.state, given.run.status);
    assert.equal(view.revision, 4);
    assert.equal(view.latestSequence, 9);
  });

await test("CLV-008 status gives the last confirmed observation, the attempted recovery, the evidence and the pending decisions", () => {
  const view = runView(
    input({
      status: "waiting_gate",
      observed: {
        condition: "infrastructure-failure",
        reason: "evidence-store-down",
        evidence: "attempt-log-2",
        attempt: 2,
        limit: 3,
      },
      gates: [gate("question"), { ...gate("approval"), outcome: null }],
    }),
  );
  assert.deepEqual(view.lastConfirmedObservation, {
    at: "2026-10-10T12:00:00.000Z",
    sequence: 7,
    source: "worker",
  });
  assert.deepEqual(view.recovery, { attempts: 2, limit: 3 });
  assert.deepEqual(view.evidence, ["event:7", "attempt-log-2"]);
  assert.deepEqual(view.pendingDecisions, [
    "run-1/question-1",
    "run-1/approval-1",
  ]);
  const quiet = runView(input({ status: "queued" }));
  assert.equal(quiet.lastConfirmedObservation, null);
  assert.deepEqual(quiet.recovery, { attempts: 0, limit: null });
  assert.deepEqual(quiet.evidence, []);
});

await test("CLV-008 a failed evidence or infrastructure operation does not request code repair", () => {
  for (const reason of ["evidence-store-down", "credentials-expired"]) {
    const view = runView(
      input({
        status: "running",
        observed: { condition: "infrastructure-failure", reason },
      }),
    );
    assert.notEqual(view.nextAction, "repair-code");
    assert.equal(view.condition, "infrastructure-failure");
  }
});
