import assert from "node:assert/strict";
import { test } from "node:test";
import { spendNotice } from "../src/daemon/queue-status.ts";
import { record } from "../src/protocol.ts";
import {
  parseTokenPrices,
  priceForModel,
  estimatedCostUsd,
} from "../src/token-prices.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { eventually } from "./service-fixture.ts";

await test("CLV-241 two lanes hold a third run after 9 USD reported and 8.10 USD estimated", () =>
  withQueueSpend(async (scene) => {
    const first = await scene.begin("A");
    const second = await scene.begin("B");
    await scene.turn(first, { harness: "claude", costUsd: 9 });
    await scene.finish(first);
    scene.clock.now = "2026-10-10T13:00:00.000Z";
    await scene.turn(second, {
      harness: "codex",
      estimatedCostUsd: estimatedCostUsd(
        { input_tokens: 8100000, cache_read_input_tokens: 0, output_tokens: 0 },
        {
          worker: "codex",
          price: priceForModel(
            parseTokenPrices(
              '{"fixture-codex":{"input":1,"cachedInput":0,"output":1}}',
            ),
            "fixture-codex",
          ),
        },
      ),
    });
    await scene.finish(second);
    scene.startQueue();
    await eventually(async () => {
      const status = await scene.status();
      return record(record(status["queue"])?.["spend"])?.["holding"] === true ||
        scene.counts.admissions > 2
        ? true
        : undefined;
    });
    await cycles(scene);
    assert.equal(
      scene.counts.admissions,
      2,
      "spend must hold the third admission",
    );
    assert.deepEqual(record((await scene.status())["queue"])?.["spend"], {
      limitUsd: 20,
      spentUsd: 17.1,
      unknownTurns: 0,
      turnsInWork: 0,
      windowHours: 24,
      holding: true,
    });
  }));

await test("CLV-241 daemon passes the configured spend limit to status", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const daemon = await launched({ queueDailySpendLimitUsd: 20 });
try {
  assert.deepEqual((await asked("status")).queue.spend, { limitUsd: 20, spentUsd: 0, unknownTurns: 0, turnsInWork: 0, windowHours: 24, holding: false });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-241 running turns settle during a hold and rolling settlement expiry resumes admissions", () =>
  withQueueSpend(async (scene) => {
    const first = await scene.begin("A");
    await scene.turn(first, { costUsd: 9, estimatedCostUsd: 100 });
    await scene.finish(first);
    const second = await scene.begin("B");
    const third = await scene.begin("C");
    const later = await scene.pendingTurn(third);
    scene.clock.now = "2026-10-10T13:00:00.000Z";
    await scene.turn(second, { estimatedCostUsd: 8.1 });
    await scene.finish(second);
    scene.startQueue();
    assert.deepEqual(record((await scene.status())["queue"])?.["spend"], {
      limitUsd: 20,
      spentUsd: 17.1,
      unknownTurns: 0,
      turnsInWork: 1,
      windowHours: 24,
      holding: true,
    });
    await later({ costUsd: 4 });
    await (
      await scene.pendingTurn(third, 2)
    )({});
    await scene.finish(third);
    assert.deepEqual(record((await scene.status())["queue"])?.["spend"], {
      limitUsd: 20,
      spentUsd: 21.1,
      unknownTurns: 1,
      turnsInWork: 0,
      windowHours: 24,
      holding: true,
    });
    await scene.restart();
    assert.equal(
      record(record((await scene.status())["queue"])?.["spend"])?.["holding"],
      true,
    );
    assert.equal(scene.counts.admissions, 3);
    scene.clock.now = "2026-10-11T12:00:00.000Z";
    await eventually(() => (scene.counts.admissions > 3 ? true : undefined));
    assert.deepEqual(record((await scene.status())["queue"])?.["spend"], {
      limitUsd: 20,
      spentUsd: 12.1,
      unknownTurns: 1,
      turnsInWork: 0,
      windowHours: 24,
      holding: false,
    });
  }));

await test("CLV-241 spend at exactly 85 percent holds before and after restart", () =>
  withQueueSpend(async (scene) => {
    const runId = await scene.begin("boundary");
    await scene.turn(runId, { costUsd: 17 });
    await scene.finish(runId);
    scene.startQueue();
    await eventually(() => (scene.messages.length === 1 ? true : undefined));
    await cycles(scene);
    assert.equal(scene.counts.admissions, 1);
    await scene.restart();
    await eventually(() => (scene.messages.length === 2 ? true : undefined));
    await cycles(scene);
    assert.equal(scene.counts.admissions, 1);
  }));

await test("CLV-241 spend at 84.99 percent admits another run", () =>
  withQueueSpend(async (scene) => {
    const runId = await scene.begin("below");
    await scene.turn(runId, { costUsd: 16.998 });
    await scene.finish(runId);
    assert.equal(
      record(record((await scene.status())["queue"])?.["spend"])?.["holding"],
      false,
    );
    scene.startQueue();
    await eventually(() => (scene.counts.admissions > 1 ? true : undefined));
    assert.deepEqual(scene.messages, []);
  }));

await test("CLV-241 unknown queue cost stays null and excludes priced manual workflows", () =>
  withQueueSpend(async (scene) => {
    const manual = await scene.begin("manual", "manual");
    await scene.turn(manual, { costUsd: 1000 });
    await scene.finish(manual);
    const runId = await scene.begin("unknown");
    await scene.turn(runId, { costUsd: "invalid", estimatedCostUsd: null });
    await scene.finish(runId);
    assert.deepEqual(record((await scene.status())["queue"])?.["spend"], {
      limitUsd: 20,
      spentUsd: null,
      unknownTurns: 1,
      turnsInWork: 0,
      windowHours: 24,
      holding: false,
    });
    scene.startQueue();
    await eventually(() => (scene.counts.admissions > 1 ? true : undefined));
  }));

await test("CLV-241 spend notices print once per transition into a hold", () => {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (line: string | Uint8Array) => {
    lines.push(String(line));
    return true;
  };
  try {
    const notice = spendNotice();
    for (const holding of [false, true, true, true, false, false, true, true])
      assert.equal(notice({ holding }), holding);
    assert.deepEqual(lines, [
      "Queue holding for spend limit\n",
      "Queue holding for spend limit\n",
    ]);
  } finally {
    process.stderr.write = original;
  }
});

async function cycles(scene: {
  readonly counts: { readonly clockReads: number };
}): Promise<void> {
  const reads = scene.counts.clockReads;
  await eventually(() =>
    scene.counts.clockReads >= reads + 10 ? true : undefined,
  );
}

await test("CLV-241 decimal costs at exactly 85 percent hold without losing sub-cent precision", () =>
  withQueueSpend(
    async (scene) => {
      const first = await scene.begin("decimal");
      await scene.turn(first, { costUsd: 0.02 });
      await (
        await scene.pendingTurn(first, 2)
      )({ costUsd: 0.15 });
      await scene.finish(first);
      assert.deepEqual(record((await scene.status())["queue"])?.["spend"], {
        limitUsd: 0.2,
        spentUsd: 0.17,
        unknownTurns: 0,
        turnsInWork: 0,
        windowHours: 24,
        holding: true,
      });
      scene.startQueue();
      await cycles(scene);
      assert.equal(scene.counts.admissions, 1);
    },
    { limitUsd: 0.2 },
  ));
