import assert from "node:assert/strict";
import { test } from "node:test";
import { withQueueSpend } from "./queue-spend-fixture.ts";
import { call } from "./service-fixture.ts";

for (const [scope, code] of [
  [undefined, undefined],
  ["all", "queue-spend-limit"],
] as const)
  await test(`CLV-308 with spend.scope ${scope ?? "queue"} a manual run outside the queue after 85 percent of the daily limit gets ${code ?? "admission"}`, () =>
    withQueueSpend(
      async (scene) => {
        const manual = await scene.begin("manual-spend", "manual");
        await scene.turn(manual, { costUsd: 17 });
        await scene.finish(manual);
        const reply = await call(scene.harness, {
          operation: "run",
          parameters: {
            workflowId: "manual",
            source: "prompt",
            submission: { prompt: "after the spend" },
            commandId: "manual-after-spend",
          },
        });
        assert.equal(reply["code"], code, JSON.stringify(reply));
      },
      scope === undefined ? {} : { spendScope: scope },
    ));
