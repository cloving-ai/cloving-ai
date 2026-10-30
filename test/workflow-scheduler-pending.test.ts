import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { reached, withScheduler } from "./workflow-scheduler-fixture.ts";

const reservation = {
  everySeconds: 300,
  nextAt: 600000,
  lastSlot: 1,
  activeCommandId: "schedule:review:1",
  pending: { kind: "run", input: { prompt: "saved" } },
};

await test("CLV-242 pause reconciles an unacknowledged run before returning paused", () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  return withScheduler(
    {
      initial: { review: reservation },
      handle: async (request) => {
        if (request.operation === "run") {
          entered.resolve(undefined);
          await release.promise;
        }
        return { kind: "result", result: { run: { state: "running" } } };
      },
    },
    async (scene) => {
      const pausing = scene.control({ action: "pause", workflowId: "review" });
      try {
        assert.equal(
          await Promise.race([
            entered.promise.then(() => "entered"),
            pausing.then(() => "returned"),
          ]),
          "entered",
        );
      } finally {
        release.resolve(undefined);
      }
      const paused = await pausing;
      assert.equal(paused.kind, "result");
      const schedule = record(paused.result["schedule"]);
      assert.ok(schedule);
      assert.equal(schedule["state"], "paused");
      assert.equal(schedule["activeRunId"], runIdentity("schedule:review:1"));
      const checkpoint = record(
        record(JSON.parse(await scene.saved()))?.["review"],
      );
      assert.equal(checkpoint?.["pending"], undefined);
      assert.equal(checkpoint?.["activeCommandId"], "schedule:review:1");
      scene.now(1200000);
      await scene.restart();
      await reached(() =>
        scene.requests.some((request) => request.operation === "status"),
      );
      await scene.stop();
      assert.equal(
        scene.requests.filter((request) => request.operation === "run").length,
        1,
      );
    },
  );
});

await test("CLV-242 pause finishes a reserved skip before persistence; resume waits a full interval", () => {
  const commands: unknown[] = [];
  return withScheduler(
    {
      initial: {
        review: {
          ...reservation,
          lastSlot: 2,
          pending: { kind: "skip", runId: "run-one" },
        },
      },
      submit: (command) => {
        commands.push(command);
        return Promise.resolve({ kind: "accepted", sequence: 1, intents: [] });
      },
      handle: () =>
        Promise.resolve({
          kind: "result",
          result: { run: { state: "completed" } },
        }),
    },
    async (scene) => {
      await scene.control({ action: "pause", workflowId: "review" });
      assert.equal(commands.length, 1);
      scene.now(1200000);
      await scene.restart();
      await reached(
        async () =>
          record(record(JSON.parse(await scene.saved()))?.["review"])?.[
            "activeCommandId"
          ] === undefined,
      );
      assert.equal(
        scene.requests.filter((request) => request.operation === "run").length,
        0,
      );
      assert.equal(commands.length, 1);
      await scene.control({ action: "resume", workflowId: "review" });
      scene.now(1499999);
      await scene.restart();
      assert.equal(
        scene.requests.filter((request) => request.operation === "run").length,
        0,
      );
      scene.now(1500000);
      await reached(() =>
        scene.requests.some((request) => request.operation === "run"),
      );
      assert.equal(
        scene.requests.at(-1)?.parameters["commandId"],
        "schedule:review:3",
      );
    },
  );
});
