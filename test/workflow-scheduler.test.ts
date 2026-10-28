import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { reached, withScheduler } from "./workflow-scheduler-fixture.ts";

const progress = {
  everySeconds: 300,
  nextAt: 600000,
  lastSlot: 1,
  activeCommandId: "schedule:review:1",
};

await test("CLV-179 an unscheduled daemon creates no schedule state", () =>
  withScheduler({ declarations: [] }, async (scene) => {
    await scene.stop();
    assert.equal(existsSync(scene.file), false);
    assert.equal(scene.requests.length, 0);
  }));

await test("CLV-179 an unacknowledged slot replays the saved input and identity", () =>
  withScheduler(
    {
      initial: {
        review: {
          ...progress,
          pending: { kind: "run", input: { prompt: "original" } },
        },
      },
    },
    async (scene) => {
      await reached(
        async () =>
          scene.requests.length === 1 &&
          !(await scene.saved()).includes('"pending"'),
      );
      assert.deepEqual(scene.requests[0]?.parameters, {
        workflowId: "review",
        source: "declared",
        submission: { prompt: "original" },
        commandId: "schedule:review:1",
      });
      assert.equal(scene.requests[0].operation, "run");
    },
  ));

await test("CLV-179 a lost submission reply retains the pending slot for restart", () => {
  let attempts = 0;
  return withScheduler(
    {
      handle: () =>
        Promise.resolve(
          ++attempts === 1
            ? { kind: "error", error: { code: "lost-reply", detail: "retry" } }
            : { kind: "result", result: {} },
        ),
    },
    async (scene) => {
      scene.now(300000);
      await reached(() => attempts === 1);
      await scene.stop();
      assert.match(await scene.saved(), /"pending"/);
      await scene.restart();
      await reached(
        async () =>
          attempts === 2 && !(await scene.saved()).includes('"pending"'),
      );
      assert.deepEqual(scene.requests[0], scene.requests[1]);
    },
  );
});

await test("CLV-179 a pending skip accepts a duplicate receipt without changing run status", () => {
  const commands: unknown[] = [];
  return withScheduler(
    {
      initial: {
        review: { ...progress, pending: { kind: "skip", runId: "run-1" } },
      },
      submit: (command) => {
        commands.push(command);
        return Promise.resolve({ kind: "duplicate", sequence: 1, intents: [] });
      },
    },
    async (scene) => {
      await reached(
        async () =>
          commands.length === 1 && !(await scene.saved()).includes('"pending"'),
      );
      assert.deepEqual(commands, [
        {
          kind: "record-schedule-skip",
          commandId: "skip:schedule:review:1",
          runId: "run-1",
          workflowId: "review",
          slot: 1,
        },
      ]);
      assert.equal(scene.requests.length, 0);
    },
  );
});

await test("CLV-179 changing an interval retains increasing slot identities", () =>
  withScheduler(
    { initial: { review: { everySeconds: 60, nextAt: 60000, lastSlot: 4 } } },
    async (scene) => {
      scene.now(300000);
      await reached(() => scene.requests.length === 1);
      assert.equal(
        scene.requests[0]?.parameters["commandId"],
        "schedule:review:5",
      );
    },
  ));

async function interruptedRequest(operation: "run" | "status"): Promise<void> {
  const release = Promise.withResolvers<undefined>();
  const expected =
    operation === "run"
      ? {
          everySeconds: 300,
          nextAt: 600000,
          lastSlot: 1,
          pending: { kind: "run", input: { prompt: "current" } },
        }
      : progress;
  let closed: (() => boolean) | undefined;
  let stalled = true;
  await withScheduler(
    {
      initial: operation === "status" ? { review: progress } : undefined,
      handle: async (_request, connection) => {
        if (stalled) {
          closed = connection.closed;
          await release.promise;
        }
        return { kind: "result", result: { run: { state: "completed" } } };
      },
    },
    async (scene) => {
      scene.now(operation === "run" ? 300000 : 600000);
      await reached(() => closed !== undefined);
      assert.equal(scene.requests[0]?.operation, operation);
      const saved = await scene.saved();
      let stopped = false;
      const stopping = scene.stop().then(() => {
        stopped = true;
      });
      try {
        await reached(() => stopped && closed?.() === true);
        assert.equal(await scene.saved(), saved);
        assert.deepEqual(JSON.parse(saved), { review: expected });
      } finally {
        stalled = false;
        release.resolve(undefined);
        await stopping;
      }
      await scene.restart();
      await reached(
        async () =>
          scene.requests.length === (operation === "run" ? 2 : 3) &&
          !(await scene.saved()).includes('"pending"'),
      );
      assert.equal(scene.requests.at(-1)?.operation, "run");
      assert.deepEqual(scene.requests.at(-1)?.parameters, {
        workflowId: "review",
        source: "declared",
        submission: { prompt: "current" },
        commandId:
          operation === "run" ? "schedule:review:1" : "schedule:review:2",
      });
    },
  );
}

await test("CLV-179 stopping interrupts a stalled submission and replays its pending slot", () =>
  interruptedRequest("run"));

await test("CLV-179 stopping interrupts a stalled status request without consuming its slot", () =>
  interruptedRequest("status"));
