import assert from "node:assert/strict";
import { test } from "node:test";
import { runIdentity } from "../src/service/submission-handler.ts";
import { record } from "../src/protocol.ts";
import { reached, withScheduler } from "./workflow-scheduler-fixture.ts";

const progress = {
  everySeconds: 300,
  nextAt: 600000,
  lastSlot: 1,
  state: "active",
  failuresInRow: 1,
  failedRunIds: ["failed-one"],
  activeCommandId: "schedule:review:1",
};

await test("CLV-242 pause keeps the active run and skips no slots; resume is idempotent", () =>
  withScheduler({ initial: { review: progress } }, async (scene) => {
    const paused = await scene.control({
      action: "pause",
      workflowId: "review",
    });
    assert.equal(paused.kind, "result");
    scene.now(1200000);
    await scene.control({ action: "list" });
    await scene.restart();
    const list = await scene.control({ action: "list" });
    assert.equal(list.kind, "result");
    const schedules = list.result["schedules"];
    assert.ok(Array.isArray(schedules));
    const listed = record(schedules[0]);
    assert.ok(listed);
    assert.deepEqual(listed, {
      workflowId: "review",
      everySeconds: 300,
      state: "paused",
      failuresInRow: 1,
      failedRunIds: ["failed-one"],
      lastSlot: 1,
      nextAt: null,
      activeRunId: runIdentity("schedule:review:1"),
      stoppedAt: null,
      stoppedSlot: null,
      stops: [],
    });
    assert.equal(
      scene.requests.filter((request) => request.operation === "run").length,
      0,
    );
    assert.equal((await scene.saved()).includes('"pending"'), false);
    assert.deepEqual(
      await scene.control({ action: "pause", workflowId: "review" }),
      {
        kind: "result",
        result: { schemaVersion: 1, kind: "schedule", schedule: listed },
      },
    );
    await scene.control({ action: "resume", workflowId: "review" });
    scene.now(1250000);
    await scene.control({ action: "resume", workflowId: "review" });
    const saved = record(record(JSON.parse(await scene.saved()))?.["review"]);
    assert.ok(saved);
    assert.equal(saved["nextAt"], 1500000);
    assert.equal(saved["failuresInRow"], 0);
    assert.deepEqual(saved["failedRunIds"], []);
  }));

await test("CLV-242 resume from stopped waits an interval and keeps a new slot after restart", () =>
  withScheduler(
    {
      initial: {
        review: {
          ...progress,
          state: "stopped",
          failuresInRow: 3,
          failedRunIds: ["one", "two", "three"],
          stoppedAt: 500000,
          stoppedSlot: 1,
          activeCommandId: undefined,
        },
      },
    },
    async (scene) => {
      scene.now(1200000);
      await scene.restart();
      await scene.control({ action: "resume", workflowId: "review" });
      scene.now(1499999);
      await scene.restart();
      assert.equal(scene.requests.length, 0);
      scene.now(1500000);
      await reached(() =>
        scene.requests.some((request) => request.operation === "run"),
      );
      assert.equal(
        scene.requests[0]?.parameters["commandId"],
        "schedule:review:2",
      );
    },
  ));
