import assert from "node:assert/strict";
import { test } from "node:test";
import { field, items, withHarness } from "./service-fixture.ts";
import { view } from "./service-views.ts";
import {
  reportTurn,
  workerScene,
  scenarioTotal,
} from "./worker-report-fixture.ts";

await test("CLV-105 single-run status totals stored estimates once and preserves reported prices across restart", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    for (const [index, costUsd] of [null, 0.25].entries())
      await reportTurn(scene, {
        round: index + 1,
        result: JSON.stringify({
          usage: scenarioTotal,
          costUsd,
          estimatedCostUsd: 2.2,
        }),
      });
    const status = await view(harness, scene.runId);
    assert.equal(field(status, "estimatedCostUsd"), 4.4);
    assert.equal(field(status, "claudeCostUsd"), null);
    assert.deepEqual(
      items(field(status, "workerTurns")).map((turn) => [
        field(turn, "estimatedCostUsd"),
        field(turn, "costUsd"),
      ]),
      [
        [2.2, null],
        [2.2, 0.25],
      ],
    );
    await scene.service.close();
    const reopened = await harness.start(scene.options);
    assert.equal(
      field(await view(harness, scene.runId), "estimatedCostUsd"),
      4.4,
    );
    await reopened.close();
  }));

await test("CLV-105 run estimates require every ended turn, validate stored values and retain zeros", async () => {
  for (const estimate of [undefined, null, -1, "3", 0, 2, Number.MAX_VALUE])
    await withHarness(async (harness) => {
      const scene = await workerScene(harness);
      assert.equal(
        field(await view(harness, scene.runId), "estimatedCostUsd"),
        null,
      );
      for (const round of [1, 2])
        await reportTurn(scene, {
          round,
          outcome: "failed",
          result: JSON.stringify({
            usage: scenarioTotal,
            costUsd: 0.25,
            estimatedCostUsd: round === 1 ? estimate : 0,
          }),
        });
      const status = await view(harness, scene.runId);
      assert.equal(
        field(status, "estimatedCostUsd"),
        typeof estimate === "number" && estimate >= 0 ? estimate : null,
      );
      assert.equal(field(status, "claudeCostUsd"), 0.5);
      await reportTurn(scene, { round: 3, outcome: "failed" });
      assert.equal(
        field(await view(harness, scene.runId), "estimatedCostUsd"),
        null,
      );
    });
});
