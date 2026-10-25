import assert from "node:assert/strict";
import { test } from "node:test";
import { reached, withScheduler } from "./workflow-scheduler-fixture.ts";

const progress = {
  everySeconds: 300,
  nextAt: 600000,
  lastSlot: 1,
  activeCommandId: "schedule:review:1",
};

await test("CLV-179 all terminal states release the next scheduled slot", async () => {
  for (const state of ["completed", "failed", "cancelled"])
    await withScheduler(
      {
        initial: { review: progress },
        handle: () =>
          Promise.resolve({ kind: "result", result: { run: { state } } }),
      },
      async (scene) => {
        scene.now(600000);
        await reached(() => scene.requests.length === 2);
        assert.equal(scene.requests[0]?.operation, "status");
        assert.equal(
          scene.requests[1]?.parameters["commandId"],
          "schedule:review:2",
        );
      },
    );
});

await test("CLV-179 queued, waiting and paused scheduled runs continue to block overlap", async () => {
  for (const state of ["queued", "waiting_gate", "paused"]) {
    const commands: unknown[] = [];
    await withScheduler(
      {
        initial: { review: progress },
        handle: () =>
          Promise.resolve({ kind: "result", result: { run: { state } } }),
        submit: (command) => {
          commands.push(command);
          return Promise.resolve({
            kind: "accepted",
            sequence: 1,
            intents: [],
          });
        },
      },
      async (scene) => {
        scene.now(600000);
        await reached(() => commands.length === 1);
        await scene.stop();
        assert.equal(scene.requests.length, 1);
        assert.equal(scene.requests[0]?.operation, "status");
        assert.match(await scene.saved(), /"lastSlot":2/);
      },
    );
  }
});

await test("CLV-179 unknown or malformed run status stops submissions without consuming the slot", async () => {
  for (const reply of [
    {
      kind: "error" as const,
      error: { code: "unknown-run", detail: "missing" },
    },
    { kind: "result" as const, result: { run: {} } },
  ])
    await withScheduler(
      { initial: { review: progress }, handle: () => Promise.resolve(reply) },
      async (scene) => {
        scene.now(600000);
        await reached(() => scene.requests.length === 1);
        await scene.stop();
        assert.deepEqual(JSON.parse(await scene.saved()), { review: progress });
        assert.equal(scene.requests[0]?.operation, "status");
      },
    );
});

await test("CLV-179 a refused skip is retained for a retry after restart", () => {
  let attempts = 0;
  return withScheduler(
    {
      initial: {
        review: { ...progress, pending: { kind: "skip", runId: "run-1" } },
      },
      submit: () =>
        Promise.resolve(
          ++attempts === 1
            ? { kind: "rejected", reason: "storage-unavailable" }
            : { kind: "accepted", sequence: 1, intents: [] },
        ),
    },
    async (scene) => {
      await reached(() => attempts === 1);
      await scene.stop();
      assert.match(await scene.saved(), /"pending"/);
      await scene.restart();
      await reached(
        async () =>
          attempts === 2 && !(await scene.saved()).includes('"pending"'),
      );
      assert.equal(scene.requests.length, 0);
    },
  );
});
