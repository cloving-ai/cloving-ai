import assert from "node:assert/strict";
import { test } from "node:test";
import { runWait, type RunWaitPorts } from "../src/host/run-wait.ts";
import { registerStepBridge } from "../src/host/step-bridge-host.ts";
import { waitForRun } from "../src/steps/wait-for-run.ts";
import type { RunWaitTarget } from "../src/run-wait.ts";

const request = { runId: "child", maximumWaitSeconds: 1 };
const caller = { runId: "parent", stepId: "step-one", startedAt: 1000 };
const outcome = { kind: "blocked", reason: "too big", promotionId: null };

await test("CLV-180 the public wait helper requires a host and returns its awaited result", async () => {
  await assert.rejects(waitForRun(request), /cloving-host-unavailable/);
  const inert = {
    effect: () =>
      Promise.resolve({ kind: "unavailable", reason: "unused" } as const),
    gate: () =>
      Promise.resolve({ kind: "unavailable", reason: "unused" } as const),
  };
  const absent = registerStepBridge(inert);
  try {
    await assert.rejects(waitForRun(request), /cloving-host-unavailable/);
  } finally {
    absent();
  }
  const remove = registerStepBridge({
    ...inert,
    waitForRun: (given) => {
      assert.deepEqual(given, request);
      return Promise.resolve(outcome);
    },
  });
  try {
    assert.deepEqual(await waitForRun(request), outcome);
  } finally {
    remove();
  }
});

await test("CLV-180 SDK retries preserve the deadline and durably report waiting and expiry", async () => {
  const clock = { now: 1000 };
  const reports: Parameters<RunWaitPorts["observe"]>[0][] = [];
  const ports: RunWaitPorts = {
    now: () => clock.now,
    target: () =>
      Promise.resolve({
        parentRunId: "parent",
        status: "running",
        endedAt: null,
        outcome: null,
      }),
    observe: (report) => {
      reports.push(report);
      return Promise.resolve({ kind: "accepted" });
    },
  };
  await assert.rejects(runWait(ports, { caller, request }), {
    name: "RetryableError",
    message: "awaiting-run",
  });
  assert.equal(reports[0]?.condition, "waiting-run");
  assert.equal(reports[0].evidence, "child");
  assert.equal(reports[0].retryAt, "1970-01-01T00:00:02.000Z");
  clock.now += 1000;
  await assert.rejects(runWait(ports, { caller, request }), {
    name: "FatalError",
    message: "run-wait-timeout",
  });
  assert.equal(reports[1]?.condition, "working");
});

await test("CLV-180 a failed observation cannot acknowledge a completed wait; recovery reuses the report ID", async () => {
  const clock = { now: 1500 };
  const target: RunWaitTarget = {
    parentRunId: "parent",
    status: "completed",
    endedAt: 1400,
    outcome,
  };
  const reports: Parameters<RunWaitPorts["observe"]>[0][] = [];
  const ports: RunWaitPorts = {
    now: () => clock.now,
    target: () => Promise.resolve(target),
    observe: (report) => {
      reports.push(report);
      return Promise.resolve({
        kind: reports.length === 1 ? "failed" : "duplicate",
      });
    },
  };
  await assert.rejects(runWait(ports, { caller, request }), {
    name: "RetryableError",
    message: "run-wait-observation-unavailable",
  });
  clock.now += 2000;
  assert.deepEqual(await runWait(ports, { caller, request }), outcome);
  assert.equal(reports[0]?.commandId, reports[1]?.commandId);
});

await test("CLV-180 an unrelated run fails without exposing its outcome", async () => {
  const ports: RunWaitPorts = {
    target: () =>
      Promise.resolve({
        parentRunId: "someone-else",
        status: "completed",
        endedAt: 1400,
        outcome,
      }),
    observe: () => Promise.resolve({ kind: "accepted" }),
  };
  await assert.rejects(runWait(ports, { caller, request }), {
    name: "FatalError",
    message: "run-wait-refused",
  });
});
