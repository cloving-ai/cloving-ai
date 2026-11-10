import assert from "node:assert/strict";
import { test } from "node:test";
import { withQueueSpend } from "./queue-spend-fixture.ts";
import { call } from "./service-fixture.ts";

await test("CLV-312 the spend operation gives the queue spend of the last 24 hours with no daily spend limit, for the workspace supervisor", () =>
  withQueueSpend(
    async (scene) => {
      const queued = await scene.begin("queued-spend", "queued");
      await scene.turn(queued, { costUsd: 3.25 });
      await scene.finish(queued);
      const manual = await scene.begin("manual-spend", "manual");
      await scene.turn(manual, { costUsd: 5 });
      await scene.finish(manual);
      const open = await scene.begin("open-spend", "queued");
      await scene.pendingTurn(open);
      assert.deepEqual(
        await call(scene.harness, { operation: "spend", parameters: {} }),
        {
          schemaVersion: 1,
          kind: "spend",
          spentUsd: 3.25,
          unknownTurns: 0,
          turnsInWork: 1,
          windowHours: 24,
        },
      );
    },
    { limitUsd: null },
  ));

await test("CLV-312 the spend operation counts every workflow with spend.scope all", () =>
  withQueueSpend(
    async (scene) => {
      const manual = await scene.begin("manual-spend", "manual");
      await scene.turn(manual, { costUsd: 5 });
      await scene.finish(manual);
      assert.equal(
        (await call(scene.harness, { operation: "spend", parameters: {} }))[
          "spentUsd"
        ],
        5,
      );
    },
    { limitUsd: null, spendScope: "all" },
  ));
