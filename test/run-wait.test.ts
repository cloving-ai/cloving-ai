import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runWaitCheckAt,
  runWaitResult,
  type RunWaitTarget,
} from "../src/run-wait.ts";

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
const context = { callerRunId: "parent", stepStartedAt: 1000, now: 1000 };

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
        startedAt: 1000,
        deadline: 1000 + maximumWaitSeconds * 1000,
        nextCheckAt: Math.min(3000, 1000 + maximumWaitSeconds * 1000),
      },
    );
});

await test("CLV-180 the original deadline includes downtime and terminal outcome timing", () => {
  assert.deepEqual(
    runWaitResult(request, { ...context, target: child, now: 1999 }),
    { kind: "waiting", startedAt: 1000, deadline: 2000, nextCheckAt: 2000 },
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

await test("CLV-285 the check interval grows from two seconds to one minute and never passes the deadline", () => {
  const checks = [0, 2000, 4000, 8000, 16000, 32000, 64000, 124000, 184000];
  assert.deepEqual(
    checks.map((now) =>
      runWaitCheckAt({ startedAt: 0, deadline: 86400000, now }),
    ),
    [2000, 4000, 8000, 16000, 32000, 64000, 124000, 184000, 244000],
  );
  assert.equal(
    runWaitCheckAt({ startedAt: 0, deadline: 9000, now: 8000 }),
    9000,
  );
  assert.equal(
    runWaitCheckAt(
      { startedAt: 0, deadline: 9000, now: 0 },
      { firstMilliseconds: 1, maximumMilliseconds: 5 },
    ),
    1,
  );
  assert.equal(
    runWaitCheckAt(
      { startedAt: 0, deadline: 9000, now: 7000 },
      { firstMilliseconds: 1, maximumMilliseconds: 5 },
    ),
    7005,
  );
});

await test("CLV-285 a later check keeps the deadline of the first check and limits a start after its own start", () => {
  const later = { ...context, target: child, stepStartedAt: 31000, now: 31000 };
  const minute = { ...request, maximumWaitSeconds: 60 };
  assert.deepEqual(runWaitResult({ ...minute, startedAt: 1000 }, later), {
    kind: "waiting",
    startedAt: 1000,
    deadline: 61000,
    nextCheckAt: 61000,
  });
  assert.deepEqual(runWaitResult({ ...request, startedAt: 1000 }, later), {
    kind: "refused",
    reason: "run-wait-timeout",
  });
  assert.deepEqual(runWaitResult({ ...minute, startedAt: 40000 }, later), {
    kind: "waiting",
    startedAt: 31000,
    deadline: 91000,
    nextCheckAt: 33000,
  });
  for (const startedAt of [-1, 1000.5, NaN, Infinity])
    assert.deepEqual(runWaitResult({ ...minute, startedAt }, later), {
      kind: "refused",
      reason: "run-wait-refused",
    });
});
