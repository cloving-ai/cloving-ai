import assert from "node:assert/strict";
import { test } from "node:test";
import { runIdentity } from "../src/service/submission-handler.ts";
import { fields, items } from "./service-fixture.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { watching, type Watching } from "./watch-fixture.ts";
import { scheduledWorkflow } from "./workflow-scheduler-fixture.ts";
import { withSchedule } from "./cli-schedule-fixture.ts";

const develop = { ...scheduledWorkflow, workflowId: "develop" };

async function withLoopWatch(
  initial: unknown,
  body: (loops: {
    readonly post: (
      body: unknown,
    ) => Promise<Readonly<Record<string, unknown>>>;
    readonly row: () => Promise<Readonly<Record<string, unknown>>>;
  }) => Promise<void>,
): Promise<void> {
  await withSchedule(
    async (harness) => {
      const watch: Watching = await watching(harness.runtimeDirectory);
      try {
        const headers = actionHeaders(watch, await pageToken(watch));
        await body({
          post: async (value) => {
            const reply = await postCard(watch, {
              path: "actions/schedule",
              headers,
              body: JSON.stringify(value),
            });
            assert.equal(reply.status, 200, reply.body);
            return fields(JSON.parse(reply.body));
          },
          row: async () => {
            const response = await fetch(`${watch.address}api/v1/schedules`);
            assert.equal(response.status, 200);
            return fields(items(fields(await response.json())["schedules"])[0]);
          },
        });
      } finally {
        assert.equal(await watch.stop(), 0);
      }
    },
    { declarations: [develop], clock: 0, initial },
  );
}

await test("CLV-328 the switch pauses a real loop with no next run and resumes it with a next run", () =>
  withLoopWatch(undefined, async (loops) => {
    const active = await loops.row();
    assert.equal(active["state"], "active");
    assert.equal(active["nextAt"], new Date(300000).toISOString());
    const command = { workflowId: "develop", commandId: "c-1" };
    await loops.post({ ...command, action: "pause" });
    assert.deepEqual(
      [(await loops.row())["state"], (await loops.row())["nextAt"]],
      ["paused", null],
    );
    await loops.post({ ...command, action: "resume" });
    const resumed = await loops.row();
    assert.equal(resumed["state"], "active");
    assert.equal(resumed["nextAt"], new Date(300000).toISOString());
  }));

await test("CLV-328 a stopped loop shows stopped and its failures, and the switch on clears the count", () =>
  withLoopWatch(
    {
      develop: {
        everySeconds: 300,
        nextAt: 300000,
        lastSlot: 1,
        state: "stopped",
        failuresInRow: 3,
        failedRunIds: ["one", "two", "three"],
        stoppedAt: 200000,
        stoppedSlot: 1,
      },
    },
    async (loops) => {
      const stopped = await loops.row();
      assert.deepEqual(
        [stopped["state"], stopped["failuresInRow"], stopped["nextAt"]],
        ["stopped", 3, null],
      );
      await loops.post({
        workflowId: "develop",
        action: "resume",
        commandId: "c-1",
      });
      const resumed = await loops.row();
      assert.deepEqual(
        [resumed["state"], resumed["failuresInRow"]],
        ["active", 0],
      );
    },
  ));

await test("CLV-328 Run now admits one marked run of a real loop, keeps the next run, and refuses a second run with run-active", () =>
  withLoopWatch(undefined, async (loops) => {
    const before = await loops.row();
    const admitted = await loops.post({
      workflowId: "develop",
      action: "run",
      commandId: "r-1",
    });
    const runId = runIdentity("loop:develop:r-1");
    assert.equal(admitted["kind"], "run-admitted");
    assert.equal(admitted["runId"], runId);
    const after = await loops.row();
    assert.equal(after["nextAt"], before["nextAt"]);
    assert.equal(fields(after["lastRun"])["runId"], runId);
    const refused = await loops.post({
      workflowId: "develop",
      action: "run",
      commandId: "r-2",
    });
    assert.equal(fields(refused["error"])["code"], "run-active");
  }));
