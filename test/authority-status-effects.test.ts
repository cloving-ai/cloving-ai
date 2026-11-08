import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runView,
  unresolved,
  unresolvedEffects,
} from "../src/authority/status.ts";
import {
  continuation,
  input,
  open,
  sent,
  start,
  unknown,
  effect,
} from "./authority-status-fixture.ts";

const later = { ...sent, operationId: continuation, releasedSequence: 8 };

function reason(view: ReturnType<typeof runView>): readonly unknown[] {
  return [view.condition, view.reason.code, view.nextAction];
}

for (const outcome of ["failed", "stale-epoch"])
  await test(`CLV-008 a dropped run with a ${outcome} delivery result is cancelling, not cancelled`, () => {
    const view = runView(
      input({
        status: "cancelled",
        observed: {
          condition: "stopped",
          reason: "worker-exit",
          sequence: 9,
          operationId: start,
        },
        operations: [
          sent,
          { ...later, releasedSequence: 5, outcomes: [outcome] },
        ],
      }),
    );
    assert.deepEqual(reason(view), [
      "cancelling",
      "delivery-outcome-unknown",
      "reconcile-effect",
    ]);
    assert.equal(view.humanInputCanHelp, false);
  });

await test("CLV-049 a stop report of the last dispatched operation alone does not end the cancellation: each dispatched operation needs a confirmed stop", () => {
  const stopped = { condition: "stopped", reason: "worker-exit", sequence: 9 };
  const pending = ["cancelling", "stop-not-observed", "observe-worker-stop"];
  for (const operationId of [start, continuation, null, "other"])
    assert.deepEqual(
      reason(
        runView(
          input({
            status: "cancelled",
            observed: { ...stopped, operationId },
            operations: [sent, later],
          }),
        ),
      ),
      pending,
      String(operationId),
    );
  const ended = runView(
    input({
      status: "cancelled",
      observed: { ...stopped, operationId: continuation },
      stops: [start],
      operations: [sent, later],
    }),
  );
  assert.deepEqual(reason(ended), ["cancelled", "run-cancelled", null]);
});

await test("CLV-008 a stop report of an operation with an unknown delivery result resolves that operation", () => {
  const lostReply = { ...sent, releasedSequence: 3, outcomes: ["failed"] };
  const stopped = { condition: "stopped", reason: "worker-exit" };
  const named = runView(
    input({
      status: "cancelled",
      observed: { ...stopped, operationId: start },
      operations: [lostReply],
    }),
  );
  assert.deepEqual(reason(named), ["cancelled", "run-cancelled", null]);
  const unnamed = runView(
    input({ status: "cancelled", observed: stopped, operations: [lostReply] }),
  );
  assert.deepEqual(reason(unnamed), [
    "cancelling",
    "delivery-outcome-unknown",
    "reconcile-effect",
  ]);
});

await test("CLV-008 a queued run whose start is sent says that the worker did not report its start", () => {
  const view = runView(input({ status: "queued", operations: [sent] }));
  assert.deepEqual(reason(view), ["queued", "start-not-reported", null]);
  assert.equal(
    view.reason.detail,
    "The start is sent. The worker did not report its start.",
  );
});

await test("CLV-008 the unresolved effects are the operations with a delivery in flight or with an unknown result", () => {
  assert.deepEqual(
    unresolved([
      sent,
      { ...open, operationId: "in-flight" },
      { ...unknown, operationId: "failed" },
      { ...unknown, operationId: "stale", outcomes: ["stale-epoch"] },
      { ...unknown, operationId: "withheld", outcomes: ["failed", "withheld"] },
      { ...unknown, operationId: "found", outcomes: ["failed", "sent"] },
      { ...unknown, operationId: "blocked", outcomes: ["blocked"] },
      { ...unknown, operationId: "not-tried", outcomes: [] },
    ]),
    ["in-flight", "failed", "stale", "withheld"],
  );
  assert.deepEqual(unresolved([{ ...sent, operationId: start }]), []);
});

await test("CLV-008 the view of a quota wait gives the time of the next automatic action", () => {
  const waiting = runView(
    input({
      status: "running",
      observed: {
        condition: "quota-wait",
        reason: "provider-quota",
        retryAt: "2026-10-10T13:00:00.000Z",
      },
    }),
  );
  assert.equal(waiting.nextAction, "recheck-eligibility");
  assert.equal(waiting.nextActionAt, "2026-10-10T13:00:00.000Z");
  const unknownReset = runView(
    input({
      status: "running",
      observed: { condition: "quota-wait", reason: "provider-quota" },
    }),
  );
  assert.equal(unknownReset.nextActionAt, null);
  assert.equal(runView(input({ status: "queued" })).nextActionAt, null);
});

await test("CLV-008 a reported reason with the name of an inherited object property gets the standard detail text", () => {
  for (const name of ["constructor", "toString", "valueOf"]) {
    const view = runView(
      input({
        status: "running",
        observed: { condition: "working", reason: name },
      }),
    );
    assert.deepEqual(view.reason, {
      code: name,
      detail: "A worker reported this reason.",
    });
  }
});

await test("CLV-008 the unresolved effects of a dropped run agree with its status after a stop report of an operation", () => {
  const lostReply = { ...sent, releasedSequence: 3, outcomes: ["failed"] };
  const stopped = { condition: "stopped", reason: "worker-exit" };
  const named = input({
    status: "cancelled",
    observed: { ...stopped, operationId: start },
    operations: [lostReply],
  });
  assert.deepEqual(unresolvedEffects(named), []);
  assert.equal(runView(named).condition, "cancelled");
  const unnamed = input({
    status: "cancelled",
    observed: stopped,
    operations: [lostReply],
  });
  assert.deepEqual(unresolvedEffects(unnamed), [start]);
  assert.equal(runView(unnamed).condition, "cancelling");
  for (const status of ["running", "paused"] as const)
    assert.deepEqual(
      unresolvedEffects(
        input({
          status,
          observed: { ...stopped, operationId: start },
          operations: [lostReply],
        }),
      ),
      [],
      status,
    );
});

await test("CLV-049 the unresolved effects of a dropped run are the operations that its closure names", () => {
  const given = {
    ...input({ status: "cancelled" }),
    closure: {
      closure: "stop-not-observed",
      unresolved: ["operation-9"],
      open: false,
    } as const,
  };
  assert.deepEqual(unresolvedEffects(given), ["operation-9"]);
});

await test("CLV-322 a running run whose next effect waits for a lease shows waiting-for-lease with the time of the request, and a granted lease clears it", () => {
  const since = "2026-11-07T14:05:00.000Z";
  const waiting = runView(
    input({
      status: "running",
      effects: [
        effect({
          status: "waiting",
          reason: "ready",
          leaseGeneration: null,
          attempts: 0,
          waitingSince: since,
        }),
      ],
    }),
  );
  assert.deepEqual(reason(waiting), [
    "waiting-for-lease",
    "waiting-for-lease",
    null,
  ]);
  assert.equal(
    waiting.reason.detail,
    `The next effect waits for a free effect lease since ${since}.`,
  );
  assert.equal(waiting.humanInputCanHelp, false);
  const granted = runView(
    input({
      status: "running",
      effects: [effect({ status: "dispatch-pending", waitingSince: null })],
    }),
  );
  assert.equal(granted.condition, "working");
});

await test("CLV-322 a workflow conflict of a running run stays visible while its next effect waits for a lease", () => {
  const waiting = effect({
    status: "waiting",
    reason: "ready",
    leaseGeneration: null,
    attempts: 0,
    waitingSince: "2026-11-07T14:05:00.000Z",
  });
  const expected = {
    "world-run-conflict": [
      "infrastructure-failure",
      "world-run-conflict",
      null,
    ],
    "pinned-workflow-unavailable": [
      "infrastructure-failure",
      "pinned-workflow-unavailable",
      "restore-pinned-workflow",
    ],
  };
  for (const [code, shown] of Object.entries(expected)) {
    const view = runView(
      input({
        status: "running",
        observed: { condition: "infrastructure-failure", reason: code },
        effects: [waiting],
      }),
    );
    assert.deepEqual(reason(view), shown, code);
    assert.equal(view.humanInputCanHelp, true, code);
  }
});
