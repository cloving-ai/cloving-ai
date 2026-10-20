import assert from "node:assert/strict";
import { test } from "node:test";
import { operationOf } from "./effect-fixture.ts";
import {
  call,
  field,
  items,
  startedRun,
  withHarness,
} from "./service-fixture.ts";
import { view } from "./service-views.ts";
import { requested, untilStates } from "./service-effect-fixture.ts";
import {
  reportTurn,
  workerScene,
  scenarioUsage,
  scenarioTotal,
  turnResult,
  unknownUsage,
} from "./worker-report-fixture.ts";

await test("CLV-094 totals ended worker operations once across failed reports, reconciliation, reads, restart and other runs", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    const first = await reportTurn(scene, {
      round: 1,
      result: turnResult(scenarioUsage[0]),
    });
    await reportTurn(scene, {
      round: 2,
      result: turnResult(scenarioUsage[1]),
      outcome: "failed",
    });
    const initial = await view(harness, scene.runId);
    const turns = field(initial, "workerTurns");
    assert.deepEqual(field(initial, "usage"), scenarioTotal);
    assert.equal(field(initial, "claudeCostUsd"), null);
    assert.deepEqual(
      turns,
      scenarioUsage.map((usage, index) => ({
        operationId: operationOf(scene.runId, { round: index + 1 }),
        usage,
        costUsd: null,
        estimatedCostUsd: null,
      })),
    );
    await scene.service.worker.reportEffect({
      ...first,
      commandId: "duplicate-report",
    });
    const another = await startedRun(harness, {
      service: scene.service,
      workflowId: "develop-issue",
      commandId: "another-run",
    });
    await reportTurn(
      { ...scene, runId: another },
      { round: 1, result: turnResult(scenarioTotal, 99) },
    );
    for (let read = 0; read < 2; read += 1) {
      const status = await view(harness, scene.runId);
      assert.deepEqual(field(status, "workerTurns"), turns);
      assert.deepEqual(field(status, "usage"), scenarioTotal);
    }
    await scene.service.close();
    const reopened = await harness.start(scene.options);
    const status = await view(harness, scene.runId);
    assert.deepEqual(field(status, "workerTurns"), turns);
    assert.deepEqual(field(status, "usage"), scenarioTotal);
    await reopened.close();
  }));

await test("CLV-139 status preserves attempt models, token usage and estimates across restart", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    const attempts = ["main", "main", "fallback"].map((model, index) => ({
      attempt: index + 1,
      model,
      usage: scenarioTotal,
      costUsd: null,
      estimatedCostUsd: index === 2 ? 10 : 2,
    }));
    await reportTurn(scene, {
      round: 1,
      result: JSON.stringify({
        usage: scenarioTotal,
        attempts,
        estimatedCostUsd: 14,
      }),
    });
    const assertAttempts = async () => {
      const status = await view(harness, scene.runId);
      assert.deepEqual(
        field(field(field(status, "workerTurns"), "0"), "attempts"),
        attempts,
      );
      assert.equal(field(status, "estimatedCostUsd"), 14);
    };
    await assertAttempts();
    await scene.service.close();
    const reopened = await harness.start(scene.options);
    await assertAttempts();
    await reopened.close();
  }));

await test("CLV-139 status normalizes unknown attempt usage and refuses malformed attempt identities", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    await reportTurn(scene, {
      round: 1,
      result: JSON.stringify({ attempts: "invalid" }),
    });
    await reportTurn(scene, {
      round: 2,
      result: JSON.stringify({
        attempts: [
          null,
          "text",
          {},
          { attempt: 0, model: "main" },
          { attempt: -1, model: "main" },
          { attempt: "1", model: "main" },
          { attempt: 1, model: {} },
          {
            attempt: 2,
            model: null,
            usage: { input_tokens: 2, output_tokens: "3" },
            costUsd: -1,
            estimatedCostUsd: "4",
            extra: "private",
          },
        ],
      }),
    });
    const turns = field(await view(harness, scene.runId), "workerTurns");
    assert.equal(field(field(turns, "0"), "attempts"), undefined);
    assert.deepEqual(field(field(turns, "1"), "attempts"), [
      {
        attempt: 2,
        model: null,
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: null,
          output_tokens: null,
        },
        costUsd: null,
        estimatedCostUsd: null,
      },
    ]);
  }));

await test("CLV-094 active operations do not contribute and ended operations without a result are unknown", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    const initial = await view(harness, scene.runId);
    assert.deepEqual(field(initial, "usage"), unknownUsage);
    assert.deepEqual(field(initial, "workerTurns"), []);
    assert.equal(field(initial, "claudeCostUsd"), null);
    await reportTurn(scene, { round: 1, outcome: "failed" });
    await requested(scene, {
      commandId: "active",
      round: 2,
      capability: "claude",
    });
    await untilStates(scene, ["failed", "running"]);
    const current = await view(harness, scene.runId);
    assert.deepEqual(field(current, "usage"), unknownUsage);
    assert.equal(field(current, "claudeCostUsd"), null);
    assert.deepEqual(field(current, "workerTurns"), [
      {
        operationId: operationOf(scene.runId, { round: 1 }),
        usage: unknownUsage,
        costUsd: null,
        estimatedCostUsd: null,
      },
    ]);
    const list = await call(harness, { operation: "status", parameters: {} });
    for (const summary of items(field(list, "runs")))
      for (const name of ["usage", "workerTurns", "claudeCostUsd"])
        assert.equal(field(summary, name), undefined);
  }));

await test("CLV-094 totals preserve valid token fields, old prices and zeros while invalid fields and overflowing sums stay unknown", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    await reportTurn(scene, {
      round: 1,
      result: turnResult(
        {
          input_tokens: Number.MAX_SAFE_INTEGER,
          cache_read_input_tokens: 0,
          output_tokens: 2,
        },
        0,
      ),
    });
    await reportTurn(scene, {
      round: 2,
      result: turnResult(
        { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: "3" },
        0,
      ),
    });
    let status = await view(harness, scene.runId);
    assert.deepEqual(field(status, "usage"), {
      input_tokens: null,
      cache_read_input_tokens: 0,
      output_tokens: null,
    });
    assert.equal(field(status, "claudeCostUsd"), 0);
    await reportTurn(scene, { round: 3, result: '{"costUsd":0.25}' });
    status = await view(harness, scene.runId);
    assert.deepEqual(field(status, "usage"), unknownUsage);
    assert.equal(field(status, "claudeCostUsd"), 0.25);
  }));

await test("CLV-094 invalid or missing reported prices and overflowing price sums never become numeric totals", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    const invalid = [undefined, null, -1, "3", "overflow"];
    for (const [index, cost] of invalid.entries()) {
      const runId =
        index === 0
          ? scene.runId
          : await startedRun(harness, {
              service: scene.service,
              workflowId: "develop-issue",
              commandId: `price-${String(index)}`,
            });
      const owned = { ...scene, runId };
      await reportTurn(owned, {
        round: 1,
        result:
          cost === "overflow"
            ? '{"costUsd":1e400}'
            : turnResult(scenarioTotal, cost),
      });
      assert.equal(field(await view(harness, runId), "claudeCostUsd"), null);
    }
    const runId = await startedRun(harness, {
      service: scene.service,
      workflowId: "develop-issue",
      commandId: "sum-overflow",
    });
    for (const round of [1, 2])
      await reportTurn(
        { ...scene, runId },
        { round, result: turnResult(scenarioTotal, Number.MAX_VALUE) },
      );
    assert.equal(field(await view(harness, runId), "claudeCostUsd"), null);
  }));
