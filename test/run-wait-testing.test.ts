import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { waitForRun } from "../src/workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";

const request = { runId: "child-run", maximumWaitSeconds: 86400 };
const outcome = {
  kind: "handoff_requested",
  reason: "small ticket",
  promotionId: "size-small",
};
const waiting = { kind: "waiting" } as const;

function answers(checks: number) {
  return [...Array.from({ length: checks }, () => waiting), outcome];
}

function sleeps(milliseconds: readonly number[]) {
  return milliseconds.map((time) => [
    "sleep",
    { until: new Date(time).toISOString() },
  ]);
}

const growing = [2000, 4000, 8000, 16000, 32000, 64000];
const sixtyChecks = [
  ...growing,
  ...Array.from({ length: 54 }, (_, index) => 124000 + index * 60000),
];

await test("CLV-285 a fake run wait answers waiting for 60 checks, sleeps durably between them, then returns the outcome", async () => {
  using bridge = fakeStepBridge({ effectLimit: 0, waits: answers(60) });
  assert.deepEqual(await waitForRun(request), outcome);
  assert.deepEqual(bridge.requests, [
    ["waitForRun", request],
    ...sleeps(sixtyChecks),
  ]);
  assert.equal(bridge.spent, 0);
});

await test("CLV-285 the check interval of a fake run wait never passes the deadline", async () => {
  using bridge = fakeStepBridge({ waits: answers(4) });
  const short = { runId: "child-run", maximumWaitSeconds: 10 };
  assert.deepEqual(await waitForRun(short), outcome);
  assert.deepEqual(bridge.requests, [
    ["waitForRun", short],
    ...sleeps([2000, 4000, 8000, 10000]),
  ]);
});

await test("CLV-285 a fake waiting answer at the deadline ends the wait with the timeout", async () => {
  using bridge = fakeStepBridge({
    waits: Array.from({ length: 5 }, () => waiting),
  });
  const short = { runId: "child-run", maximumWaitSeconds: 10 };
  await assert.rejects(waitForRun(short), { message: "run-wait-timeout" });
  assert.deepEqual(bridge.requests, [
    ["waitForRun", short],
    ...sleeps([2000, 4000, 8000, 10000]),
  ]);
});

await test("CLV-285 the first check sends only the run and the maximum wait of the request", async () => {
  using bridge = fakeStepBridge({ waits: answers(1) });
  const extended = { ...request, startedAt: 5 };
  assert.deepEqual(await waitForRun(extended), outcome);
  assert.deepEqual(bridge.requests, [
    ["waitForRun", request],
    ...sleeps([2000]),
  ]);
});

await test("CLV-285 run-wait scenarios answer waiting through the public subpath", () =>
  withFiles(
    {
      "wait.mjs": `import { waitForRun } from "cloving/workflows/steps/wait-for-run";
export async function sample(input) { return await waitForRun(input); }`,
    },
    async (root) => {
      const result = await runScenario({
        workflow: join(root, "wait.mjs"),
        exportName: "sample",
        input: request,
        waits: answers(60),
      });
      assert.deepEqual(result, {
        outcome,
        requests: [["waitForRun", request], ...sleeps(sixtyChecks)],
      });
    },
  ));

await test("CLV-285 concurrent fake waits for one child keep one clock for each wait, and a later wait starts at 0 again", async () => {
  using bridge = fakeStepBridge({
    waits: [
      ...Array.from({ length: 8 }, () => waiting),
      outcome,
      outcome,
      waiting,
      outcome,
    ],
  });
  const short = { runId: "child-run", maximumWaitSeconds: 10 };
  assert.deepEqual(await Promise.all([waitForRun(short), waitForRun(short)]), [
    outcome,
    outcome,
  ]);
  assert.deepEqual(await waitForRun(short), outcome);
  assert.deepEqual(bridge.requests, [
    ["waitForRun", short],
    ["waitForRun", short],
    ...sleeps([2000, 2001, 4000, 4001, 8000, 8001, 10000, 10001]),
    ["waitForRun", short],
    ...sleeps([2000]),
  ]);
});
