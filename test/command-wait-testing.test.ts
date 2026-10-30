import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { waitForCommand } from "../src/workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";

const request = { name: "team-review", input: { change: 42 } };
const pending = {
  kind: "pending" as const,
  deadline: 30000,
  nextCheckAt: 10000,
};

for (const outcome of [
  { kind: "ready", value: { approved: true } },
  { kind: "timed-out", reason: "command-wait-timeout" },
  { kind: "failed", reason: "command-interrupted" },
] as const)
  await test(`CLV-237 fake command wait returns terminal ${outcome.kind} with no ordinary effects`, async () => {
    using bridge = fakeStepBridge({
      effectLimit: 0,
      commandWaits: {
        "team-review": [pending, { ...pending, nextCheckAt: 40000 }, outcome],
      },
    });
    assert.deepEqual(await waitForCommand(request), outcome);
    assert.deepEqual(bridge.requests, [
      ["waitForCommand", request],
      ["sleep", { until: new Date(10000).toISOString() }],
      ["sleep", { until: new Date(30000).toISOString() }],
    ]);
    assert.equal(bridge.spent, 0);
  });

await test("CLV-237 fake command wait requires a result including after pending checks", async () => {
  using bridge = fakeStepBridge({ commandWaits: { "team-review": [pending] } });
  await assert.rejects(waitForCommand(request), /no-scenario-result/);
  await assert.rejects(
    waitForCommand({ ...request, name: "missing" }),
    /no-scenario-result/,
  );
  assert.equal(bridge.spent, 0);
});

await test("CLV-237 command-wait scenarios use the public subpath with no wall-clock waiting", () =>
  withFiles(
    {
      "wait.mjs": `import { waitForCommand } from "cloving/workflows/steps/wait-for-command";
export async function sample(input) { return await waitForCommand(input); }`,
    },
    async (root) => {
      assert.deepEqual(
        await runScenario({
          workflow: join(root, "wait.mjs"),
          exportName: "sample",
          input: request,
          effectLimit: 0,
          commandWaits: {
            "team-review": [
              pending,
              { kind: "ready", value: { approved: true } },
            ],
          },
        }),
        {
          outcome: { kind: "ready", value: { approved: true } },
          spent: 0,
          requests: [
            ["waitForCommand", request],
            ["sleep", { until: new Date(10000).toISOString() }],
          ],
        },
      );
      await assert.rejects(
        runScenario({
          workflow: join(root, "wait.mjs"),
          exportName: "sample",
          input: request,
        }),
        /no-scenario-result/,
      );
    },
  ));

for (const milliseconds of [0, 20, 59987])
  await test(`CLV-237 scenarios accept a recorded ${String(milliseconds)} ms SDK suspension`, () =>
    withFiles(
      {
        "wait.mjs": `import { waitForCommand } from "cloving/workflows";
export async function sample(input) { return await waitForCommand(input); }`,
      },
      async (root) => {
        const result = await runScenario({
          workflow: join(root, "wait.mjs"),
          exportName: "sample",
          input: request,
          commandWaits: {
            "team-review": [
              { ...pending, deadline: 100000, nextCheckAt: milliseconds },
              { kind: "ready", value: null },
            ],
          },
        });
        assert.deepEqual(result.outcome, { kind: "ready", value: null });
        assert.deepEqual(result.requests, [
          ["waitForCommand", request],
          ["sleep", { until: new Date(milliseconds).toISOString() }],
        ]);
      },
    ));
