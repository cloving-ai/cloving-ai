import assert from "node:assert/strict";
import { test } from "node:test";
import { runWaitResult, type RunWaitTarget } from "../src/run-wait.ts";

const request = { runId: "child", maximumWaitSeconds: 1 };
const outcome = {
  kind: "handoff_requested",
  reason: "small ticket",
  promotionId: "size-small",
};
const child: RunWaitTarget = {
  parentRunId: "parent",
  status: "running",
  endedAt: null,
  outcome: null,
};
const context = { callerRunId: "parent", startedAt: 1000, now: 1000 };

await test("CLV-180 only a direct handoff child can be awaited with an integral bounded wait", () => {
  for (const maximumWaitSeconds of [0, -1, 1.5, 86401, NaN, Infinity])
    assert.deepEqual(
      runWaitResult(
        { ...request, maximumWaitSeconds },
        { ...context, target: child },
      ),
      { kind: "refused", reason: "run-wait-refused" },
    );
  for (const target of [
    undefined,
    { ...child, parentRunId: null },
    { ...child, parentRunId: "sibling" },
  ])
    assert.deepEqual(runWaitResult(request, { ...context, target }), {
      kind: "refused",
      reason: "run-wait-refused",
    });
  for (const maximumWaitSeconds of [1, 86400])
    assert.deepEqual(
      runWaitResult(
        { ...request, maximumWaitSeconds },
        { ...context, target: child },
      ),
      {
        kind: "waiting",
        deadline: 1000 + maximumWaitSeconds * 1000,
      },
    );
});

await test("CLV-180 the original deadline includes downtime and terminal outcome timing", () => {
  assert.deepEqual(
    runWaitResult(request, { ...context, target: child, now: 1999 }),
    { kind: "waiting", deadline: 2000 },
  );
  assert.deepEqual(
    runWaitResult(request, { ...context, target: child, now: 2000 }),
    { kind: "refused", reason: "run-wait-timeout" },
  );
  const target = { ...child, status: "completed", endedAt: 1999, outcome };
  assert.deepEqual(runWaitResult(request, { ...context, target, now: 9000 }), {
    kind: "completed",
    outcome,
  });
  assert.deepEqual(
    runWaitResult(request, {
      ...context,
      target: { ...target, endedAt: 2001 },
      now: 9000,
    }),
    { kind: "refused", reason: "run-wait-timeout" },
  );
});

for (const kind of ["blocked", "failed", "cancelled"]) {
  await test(`CLV-180 a child's ${kind} outcome retains null optional values`, () => {
    const outcome = { kind, reason: "target ended", promotionId: null };
    const target = {
      ...child,
      status: kind === "blocked" ? "completed" : kind,
      endedAt: 1500,
      outcome,
    };
    assert.deepEqual(
      runWaitResult(request, { ...context, target, now: 1600 }),
      { kind: "completed", outcome },
    );
  });
}
