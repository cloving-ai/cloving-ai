import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { sleep } from "../src/workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { join } from "node:path";

await test("CLV-233 fake sleep records requests in order without spending effects", async () => {
  using bridge = fakeStepBridge({ effectLimit: 0 });
  await sleep({ seconds: 1 });
  await sleep({ seconds: 86400 });
  assert.deepEqual(bridge.requests, [
    ["sleep", { seconds: 1 }],
    ["sleep", { seconds: 86400 }],
  ]);
  assert.equal(bridge.spent, 0);
  await assert.rejects(sleep({ seconds: 0 }), {
    message: "invalid-sleep-seconds",
  });
  assert.equal(bridge.requests.length, 2);
});

await test("CLV-233 scenario sleep uses both public surfaces without real timers", () =>
  withFiles(
    {
      "sleep.mjs": `import { sleep } from "cloving/workflows";
import { sleep as pause } from "cloving/workflows/steps/sleep";
export async function sample() {
  await sleep({ seconds: 86400 });
  await pause({ seconds: 1 });
  return "awake";
}`,
    },
    async (root) => {
      assert.deepEqual(
        await runScenario({
          workflow: join(root, "sleep.mjs"),
          exportName: "sample",
          input: null,
          effectLimit: 0,
        }),
        {
          outcome: "awake",
          requests: [
            ["sleep", { seconds: 86400 }],
            ["sleep", { seconds: 1 }],
          ],
          spent: 0,
        },
      );
    },
  ));

await test("CLV-233 fake sleep restores timer descriptors and refuses an active workflow timer", async () => {
  const key = Symbol.for("WORKFLOW_SLEEP");
  const active = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: undefined,
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  try {
    {
      using bridge = fakeStepBridge({});
      await sleep({ seconds: 1 });
      assert.equal(bridge.requests.length, 1);
    }
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis, key),
      previous,
    );
    const timer = () => Promise.resolve();
    Reflect.set(globalThis, key, timer);
    assert.throws(() => fakeStepBridge({}), {
      message: "workflow-testing-host-active",
    });
    assert.equal(Reflect.get(globalThis, key), timer);
  } finally {
    if (active === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, active);
  }
  await assert.rejects(
    sleep({ seconds: 1 }),
    /only be called inside a workflow/,
  );
});
