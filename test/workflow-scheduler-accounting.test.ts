import assert from "node:assert/strict";
import { test } from "node:test";
import { record, type Fields } from "../src/protocol.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { reached, withScheduler } from "./workflow-scheduler-fixture.ts";

const prior = {
  everySeconds: 300,
  nextAt: 900000,
  lastSlot: 2,
  state: "active",
  failuresInRow: 1,
  failedRunIds: ["failed-one"],
  activeCommandId: "schedule:review:2",
};

function saved(text: string): Fields {
  return record(record(JSON.parse(text))?.["review"]) ?? {};
}

await test("CLV-242 blocked outcomes count once before the next interval and across restart", () =>
  withScheduler(
    {
      initial: { review: prior },
      handle: () =>
        Promise.resolve({
          kind: "result",
          result: { run: { state: "completed", outcome: { kind: "blocked" } } },
        }),
    },
    async (scene) => {
      scene.now(700000);
      await reached(
        async () => saved(await scene.saved())["activeCommandId"] === undefined,
      );
      const checkpoint = saved(await scene.saved());
      assert.equal(checkpoint["failuresInRow"], 2);
      assert.deepEqual(checkpoint["failedRunIds"], [
        "failed-one",
        runIdentity("schedule:review:2"),
      ]);
      await scene.restart();
      assert.deepEqual(saved(await scene.saved()), checkpoint);
      assert.equal(scene.requests.length, 1);
    },
  ));

await test("CLV-242 cancellation preserves failures and other completions clear them", async () => {
  for (const run of [
    { state: "cancelled" },
    { state: "completed", outcome: { kind: "handoff_requested" } },
    { state: "completed" },
  ])
    await withScheduler(
      {
        initial: { review: prior },
        handle: () => Promise.resolve({ kind: "result", result: { run } }),
      },
      async (scene) => {
        await reached(
          async () =>
            saved(await scene.saved())["activeCommandId"] === undefined,
        );
        const expected = run.state === "cancelled" ? 1 : 0;
        assert.equal(saved(await scene.saved())["failuresInRow"], expected);
        assert.deepEqual(
          saved(await scene.saved())["failedRunIds"],
          expected === 1 ? ["failed-one"] : [],
        );
        assert.equal(saved(await scene.saved())["state"], "active");
      },
    );
});

await test("CLV-242 a paused active run finishes and counts without a skip or submission", () => {
  const commands: unknown[] = [];
  return withScheduler(
    {
      initial: {
        review: {
          ...prior,
          state: "paused",
          failuresInRow: 2,
          failedRunIds: ["one", "two"],
        },
      },
      handle: () =>
        Promise.resolve({
          kind: "result",
          result: { run: { state: "failed" } },
        }),
      submit: (command) => {
        commands.push(command);
        return Promise.resolve({ kind: "accepted", sequence: 1, intents: [] });
      },
    },
    async (scene) => {
      scene.now(1200000);
      await reached(
        async () => saved(await scene.saved())["state"] === "stopped",
      );
      await scene.stop();
      const checkpoint = saved(await scene.saved());
      assert.equal(checkpoint["stoppedAt"], 1200000);
      assert.equal(checkpoint["stoppedSlot"], 2);
      assert.equal(checkpoint["lastSlot"], 2);
      assert.equal(checkpoint["activeCommandId"], undefined);
      assert.deepEqual(commands, []);
      assert.deepEqual(
        scene.requests.map((request) => request.operation),
        ["status"],
      );
      await scene.restart();
      assert.deepEqual(saved(await scene.saved()), checkpoint);
    },
  );
});

await test("CLV-242 unfinished runs are polled at most once in five seconds, also while paused", async () => {
  for (const state of ["active", "paused"])
    await withScheduler(
      { initial: { review: { ...prior, state } } },
      async (scene) => {
        await reached(() => scene.requests.length >= 1);
        const first = scene.ticks();
        await reached(() => scene.ticks() >= first + 4);
        assert.equal(scene.requests.length, 1);
        scene.now(5000);
        await reached(() => scene.requests.length >= 2);
        const second = scene.ticks();
        scene.now(9999);
        await reached(() => scene.ticks() >= second + 4);
        assert.equal(scene.requests.length, 2);
        scene.now(10000);
        await reached(() => scene.requests.length >= 3);
        await scene.stop();
        assert.equal(scene.requests.length, 3);
        assert.ok(
          scene.requests.every((request) => request.operation === "status"),
        );
        assert.deepEqual(saved(await scene.saved()), { ...prior, state });
      },
    );
});

await test("CLV-242 a slot boundary observes completion even within the polling interval", () => {
  let state = "running";
  return withScheduler(
    {
      initial: { review: prior },
      handle: () =>
        Promise.resolve({ kind: "result", result: { run: { state } } }),
    },
    async (scene) => {
      scene.now(899999);
      await reached(() => scene.requests.length >= 1);
      state = "completed";
      scene.now(900000);
      await reached(() =>
        scene.requests.some((request) => request.operation === "run"),
      );
      await scene.stop();
      assert.deepEqual(
        scene.requests.map((request) => request.operation),
        ["status", "status", "run"],
      );
      assert.equal(
        scene.requests.at(-1)?.parameters["commandId"],
        "schedule:review:3",
      );
    },
  );
});

await test("CLV-242 run observation advances while the scheduling clock stays fixed", () => {
  let observedAt = 0;
  let state = "running";
  return withScheduler(
    {
      initial: { review: prior },
      observationClock: () => observedAt,
      handle: () =>
        Promise.resolve({ kind: "result", result: { run: { state } } }),
    },
    async (scene) => {
      scene.now(700000);
      await reached(() => scene.requests.length >= 1);
      state = "failed";
      observedAt = 5000;
      await reached(
        async () => saved(await scene.saved())["activeCommandId"] === undefined,
      );
      await scene.stop();
      assert.equal(scene.requests.length, 2);
      assert.equal(saved(await scene.saved())["failuresInRow"], 2);
      assert.equal(saved(await scene.saved())["nextAt"], 900000);
    },
  );
});
