import assert from "node:assert/strict";
import { test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { queueSpend } from "../src/service/queue-spend.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";

await test("CLV-241 spend reads only queue reports with a settlement inside the window", () =>
  withQueueSpend(async (scene) => {
    scene.clock.now = "2026-10-09T12:00:00.000Z";
    const expired = await scene.begin("expired");
    await scene.turn(expired, { costUsd: 1000 });
    scene.clock.now = "2026-10-10T11:00:00.000Z";
    const pending = await scene.begin("pending");
    const settle = await scene.pendingTurn(pending);
    scene.clock.now = "2026-10-10T12:00:00.000Z";
    await scene.finish(expired);
    await settle({ costUsd: 4 });
    await scene.finish(pending);
    const manual = await scene.begin("manual", "manual");
    await scene.turn(manual, { costUsd: 2000 });
    await scene.finish(manual);
    await scene.stop();
    const opening = await openAuthority(scene.harness.stateDirectory);
    assert.equal(opening.kind, "opened");
    const { authority } = opening;
    const read: string[] = [];
    try {
      const spend = await queueSpend({
        clock: () => scene.clock.now,
        queueDailySpendLimitUsd: 20,
        authority: {
          ...authority,
          queries: {
            ...authority.queries,
            document: async (digest) => {
              const text = await authority.queries.document(digest);
              if (text !== undefined) read.push(text);
              return text;
            },
          },
        },
      });
      assert.deepEqual(read, ['{"costUsd":4}']);
      assert.deepEqual(spend["spend"], {
        limitUsd: 20,
        spentUsd: 4,
        unknownTurns: 0,
        turnsInWork: 0,
        windowHours: 24,
        holding: false,
      });
    } finally {
      await authority.close();
    }
  }));
