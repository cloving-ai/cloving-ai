import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import {
  cli,
  privateSettings,
  queueScene,
  startOutput,
  statusOf,
} from "./cli-start-declared-queue-fixture.ts";

await test("CLV-373 explicit queue objects and per-workflow settings start with defaults and no interval setting", async () => {
  for (const queue of [true, {}]) {
    const { fixture, environment } = await queueScene({ queue });
    if (queue === true)
      await privateSettings(fixture, { queues: { develop: {} } });
    const output = await startOutput(fixture, {
      environment,
      inspect: () => {
        const status = record(statusOf(fixture)["queue"]);
        assert.equal(status?.["workflowId"], "develop");
        assert.deepEqual(status["settings"], {
          everySeconds: { value: 120, source: "default" },
          lanes: { value: 1, source: "default" },
          workingLanes: { value: 1, source: "default" },
        });
        assert.match(
          cli(fixture, ["status"]).stdout,
          /Queue: running, 0 of 1 lanes busy/,
        );
        assert.match(
          cli(fixture, ["queue"]).stdout,
          /Queue settings: every 120 s \(default\), 1 lanes \(default\), 1 working lanes \(default\)/,
        );
      },
    });
    assert.match(output, /Cloving runs/);
  }
});

await test("CLV-359 removing private queue limits reloads the start environment lanes and default working lanes", async () => {
  const { fixture, environment } = await queueScene({ queue: { lanes: 2 } });
  await privateSettings(fixture, {
    queues: { develop: { lanes: 3, workingLanes: 2 } },
  });
  await startOutput(fixture, {
    environment: { ...environment, CLOVING_QUEUE_LANES: "5" },
    inspect: () => {
      assert.deepEqual(record(statusOf(fixture)["queue"])?.["settings"], {
        everySeconds: { value: 120, source: "default" },
        lanes: { value: 3, source: "queues setting (private file)" },
        workingLanes: { value: 2, source: "queues setting (private file)" },
      });
      const unset = cli(fixture, ["config", "unset", "queues", "--private"]);
      assert.equal(unset.status, 0, unset.stdout + unset.stderr);
      const reload = cli(fixture, ["reload", "--json"]);
      assert.equal(reload.status, 0, reload.stdout + reload.stderr);
      const reply = record(JSON.parse(reload.stdout));
      assert.deepEqual(
        [reply?.["reloadedFields"], reply?.["restartFields"]],
        [["queues"], ["queues"]],
      );
      assert.deepEqual(record(statusOf(fixture)["queue"])?.["settings"], {
        everySeconds: { value: 120, source: "default" },
        lanes: { value: 5, source: "environment" },
        workingLanes: { value: 5, source: "default" },
      });
    },
  });
});
