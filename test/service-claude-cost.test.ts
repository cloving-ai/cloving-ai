import assert from "node:assert/strict";
import { test } from "node:test";
import { operationOf } from "./effect-fixture.ts";
import {
  effectScene,
  requested,
  shownEffects,
  untilStates,
  type Scene,
} from "./service-effect-fixture.ts";
import {
  call,
  field,
  items,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import { view } from "./service-views.ts";

const capabilities = ["claude", "fake-harness"];

function claudeScene(harness: Harness): Promise<Scene> {
  return effectScene(harness, { effectLimit: 10, capabilities });
}

async function completed(
  scene: Scene,
  turn: {
    readonly round: number;
    readonly capability: string;
    readonly result: string;
  },
): Promise<void> {
  const { round, capability, result } = turn;
  const reply = await requested(scene, {
    commandId: `c-request-${String(round)}`,
    round,
    capability,
  });
  const earlier = Array.from({ length: round - 1 }, () => "completed");
  await untilStates(scene, [...earlier, "running"]);
  const running = (await shownEffects(scene)).at(-1);
  const report = await scene.service.worker.reportEffect({
    runId: scene.runId,
    commandId: `c-report-${String(round)}`,
    operationId: operationOf(scene.runId, { round }),
    inputDigest: String(reply.operation?.inputDigest),
    leaseGeneration: Number(field(running, "leaseGeneration")),
    worker: "worker-1",
    outcome: "completed",
    result,
  });
  assert.equal(report.disposition?.disposition, "applied");
}

function costText(costUsd: number | null): string {
  return JSON.stringify({ summary: "the turn is done", costUsd });
}

async function claudeCost(scene: Scene): Promise<unknown> {
  return field(await view(scene.harness, scene.runId), "claudeCostUsd");
}

await test("CLV-066 the status of a run gives the sum of the costs of its completed Claude effects", () =>
  withHarness(async (harness) => {
    const scene = await claudeScene(harness);
    await completed(scene, {
      round: 1,
      capability: "claude",
      result: costText(1.25),
    });
    await completed(scene, {
      round: 2,
      capability: "claude",
      result: costText(0.5),
    });
    assert.equal(await claudeCost(scene), 1.75);
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(
      items(field(list, "runs")).map((listed) =>
        field(listed, "claudeCostUsd"),
      ),
      [undefined],
    );
  }));

await test("CLV-066 a run with no completed Claude effect gives a Claude cost of 0", () =>
  withHarness(async (harness) => {
    const scene = await claudeScene(harness);
    assert.equal(await claudeCost(scene), 0);
    await completed(scene, {
      round: 1,
      capability: "fake-harness",
      result: costText(2),
    });
    await requested(scene, {
      commandId: "c-request-2",
      round: 2,
      capability: "claude",
    });
    await untilStates(scene, ["completed", "running"]);
    assert.equal(await claudeCost(scene), 0);
  }));

await test("CLV-066 a Claude result with no number in costUsd adds 0, and the sum has two decimal places", () =>
  withHarness(async (harness) => {
    const scene = await claudeScene(harness);
    const results = [
      costText(0.1),
      costText(null),
      "the turn is done",
      "[0.4]",
      costText(0.2),
    ];
    for (const [index, result] of results.entries())
      await completed(scene, {
        round: index + 1,
        capability: "claude",
        result,
      });
    assert.equal(await claudeCost(scene), 0.3);
  }));

await test("CLV-066 a completed Claude effect with no result document adds 0", () =>
  withHarness(async (harness) => {
    let reconciliations = 0;
    const scene = await effectScene(harness, {
      effectLimit: 10,
      capabilities,
      effects: { resultBytes: 8 },
      reconcile: () => {
        reconciliations += 1;
        return Promise.resolve(
          reconciliations === 1
            ? {
                kind: "completed",
                receipt: "receipt-1",
                worker: "worker-1",
                result: costText(3),
              }
            : { kind: "absent" },
        );
      },
    });
    await requested(scene, {
      commandId: "c-request-1",
      round: 1,
      capability: "claude",
    });
    await untilStates(scene, ["completed"]);
    assert.equal(
      field((await shownEffects(scene))[0], "reason"),
      "result-too-large",
    );
    await completed(scene, {
      round: 2,
      capability: "claude",
      result: costText(0.25),
    });
    assert.equal(await claudeCost(scene), 0.25);
  }));
