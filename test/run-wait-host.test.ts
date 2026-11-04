import assert from "node:assert/strict";
import { test } from "node:test";
import { runWait, type RunWaitPorts } from "../src/host/run-wait.ts";
import { registerStepBridge } from "../src/host/step-bridge-host.ts";
import { checkRunWait } from "../src/steps/run-wait.ts";
import type { RunWaitTarget } from "../src/run-wait.ts";

const request = { runId: "child", maximumWaitSeconds: 1 };
const caller = { runId: "parent", stepId: "step-one", stepStartedAt: 1000 };
const outcome = { kind: "blocked", reason: "too big", promotionId: null };
const active: RunWaitTarget = {
  parentRunId: "parent",
  status: "running",
  endedAt: null,
  outcome: null,
};
type Report = Parameters<RunWaitPorts["observe"]>[0];

function activePorts(
  clock: { now: number },
  answer: (report: Report) => string,
): { readonly ports: RunWaitPorts; readonly reports: Report[] } {
  const reports: Report[] = [];
  return {
    reports,
    ports: {
      now: () => clock.now,
      target: () => Promise.resolve(active),
      observe: (report) => {
        reports.push(report);
        return Promise.resolve({ kind: answer(report) });
      },
    },
  };
}

await test("CLV-180 the public check step requires a host and returns its progress", async () => {
  await assert.rejects(checkRunWait(request), /cloving-host-unavailable/);
  const inert = {
    effect: () =>
      Promise.resolve({ kind: "unavailable", reason: "unused" } as const),
    gate: () =>
      Promise.resolve({ kind: "unavailable", reason: "unused" } as const),
  };
  const absent = registerStepBridge(inert);
  try {
    await assert.rejects(checkRunWait(request), /cloving-host-unavailable/);
  } finally {
    absent();
  }
  const remove = registerStepBridge({
    ...inert,
    checkRunWait: (given) => {
      assert.deepEqual(given, request);
      return Promise.resolve({ kind: "completed", outcome });
    },
  });
  try {
    assert.deepEqual(await checkRunWait(request), {
      kind: "completed",
      outcome,
    });
  } finally {
    remove();
  }
});

await test("CLV-285 an active child returns waiting with the next check time and repeats one waiting report", async () => {
  const clock = { now: 1000 };
  const { ports, reports } = activePorts(clock, () =>
    reports.length === 1 ? "accepted" : "duplicate",
  );
  const minute = { ...request, maximumWaitSeconds: 60 };
  assert.deepEqual(await runWait(ports, { caller, request: minute }), {
    kind: "waiting",
    startedAt: 1000,
    deadline: 61000,
    nextCheckAt: 3000,
  });
  clock.now = 3000;
  const later = { runId: "parent", stepId: "step-two", stepStartedAt: 3000 };
  assert.deepEqual(
    await runWait(ports, {
      caller: later,
      request: { ...minute, startedAt: 1000 },
    }),
    { kind: "waiting", startedAt: 1000, deadline: 61000, nextCheckAt: 5000 },
  );
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1], reports[0]);
  assert.equal(reports[0]?.condition, "waiting-run");
  assert.equal(reports[0].reason, "awaiting-run");
  assert.equal(reports[0].evidence, "child");
  assert.equal(reports[0].retryAt, "1970-01-01T00:01:01.000Z");
  assert.match(reports[0].commandId, /^[A-Za-z0-9._:/-]{1,128}$/);
});

await test("CLV-285 a failed waiting report still returns waiting, and another caller run gets another report ID", async () => {
  const clock = { now: 1000 };
  const { ports, reports } = activePorts(clock, () => "failed");
  const waiting = {
    kind: "waiting",
    startedAt: 1000,
    deadline: 2000,
    nextCheckAt: 2000,
  };
  assert.deepEqual(await runWait(ports, { caller, request }), waiting);
  const other = { ...active, parentRunId: "other-parent" };
  const otherPorts = { ...ports, target: () => Promise.resolve(other) };
  assert.deepEqual(
    await runWait(otherPorts, {
      caller: { ...caller, runId: "other-parent" },
      request,
    }),
    waiting,
  );
  assert.notEqual(reports[0]?.commandId, reports[1]?.commandId);
});

await test("CLV-180 a check after the deadline reports the end of the wait and fails with the timeout", async () => {
  const clock = { now: 2000 };
  const { ports, reports } = activePorts(clock, () => "accepted");
  await assert.rejects(
    runWait(ports, {
      caller: { ...caller, stepId: "step-two", stepStartedAt: 2000 },
      request: { ...request, startedAt: 1000 },
    }),
    { name: "FatalError", message: "run-wait-timeout" },
  );
  assert.equal(reports[0]?.condition, "working");
  assert.equal(reports[0].commandId, "step-two:run-wait:ended");
});

await test("CLV-180 a failed observation cannot acknowledge a completed wait; recovery reuses the report ID", async () => {
  const clock = { now: 1500 };
  const target: RunWaitTarget = {
    parentRunId: "parent",
    status: "completed",
    endedAt: 1400,
    outcome,
  };
  const reports: Report[] = [];
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
  assert.deepEqual(await runWait(ports, { caller, request }), {
    kind: "completed",
    outcome,
  });
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
