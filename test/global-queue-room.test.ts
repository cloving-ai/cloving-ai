import assert from "node:assert/strict";
import { test } from "node:test";
import { roomGate } from "../src/daemon/queue-room-gate.ts";
import type { QueueHold } from "../src/queue-room.ts";
import { withQueue } from "./issue-queue-fixture.ts";
import { eventually } from "./service-fixture.ts";
import type { Handle } from "../src/service/transport.ts";

await test("CLV-377 global limits hold automatic intake honestly and clear when work capacity returns", async () => {
  const limit = { lanes: 2, workingLanes: 1 };
  const counts = { busy: 3, working: 1 };
  let hold: QueueHold | undefined;
  const gate = roomGate(
    {
      limits: () => ({ lanes: 4, workingLanes: 4, global: limit }),
      waiting: () => Promise.resolve(0),
      signals: () =>
        Promise.resolve({ loadAverage: 0, cores: 8, memoryPressure: "normal" }),
      repositoryBusy: () => Promise.resolve(counts.busy),
      repositoryWorking: () => Promise.resolve(counts.working),
    },
    (value) => {
      hold = value;
      return Promise.resolve();
    },
  );
  assert.equal(await gate.open(0), false);
  assert.deepEqual(hold, {
    reason: "repository-lanes",
    busy: 3,
    limit: 2,
    text: "Held: 3 of 2 global queue lanes busy",
  });
  limit.lanes = 4;
  assert.equal(await gate.open(0), false);
  assert.match(hold.text, /1 of 1 global active-work lanes busy/);
  counts.working = 0;
  assert.equal(await gate.open(0), true);
  assert.equal(hold, undefined);
});

await test("CLV-377 a final global active-work refusal holds the polling queue without stopping or counting a failure", () => {
  const state = { attempts: 0 };
  return withQueue(
    {
      handle: globalWorkRefusal(state),
    },
    async (scene) => {
      await eventually(() =>
        state.attempts > 1 || scene.control()?.error !== undefined
          ? true
          : undefined,
      );
      assert.equal(scene.control()?.error, undefined);
      assert.ok(state.attempts > 1);
      assert.deepEqual(scene.control()?.failedRunIds, []);
    },
  );
});

function globalWorkRefusal(state: { attempts: number }): Handle {
  return (request) => {
    if (request.operation === "run") {
      state.attempts += 1;
      return Promise.resolve({
        kind: "error",
        error: {
          code: "queue-global-working-full",
          detail: "Global work is full",
        },
      });
    }
    return Promise.resolve({
      kind: "result",
      result: { runs: [], next: null },
    });
  };
}
