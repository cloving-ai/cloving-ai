import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-309 the queue holds runs for load and memory pressure, shows the reason in status, and starts when the machine has room", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const signals = { current: { loadAverage: 10.8, cores: 12, memoryPressure: "normal" } };
const queueOf = async () => (await asked("status")).queue;
const daemon = await launched({
  queueLimits: { lanes: 1, workingLanes: 1, room: { maxLoadPerCore: 0.7, maxMemoryPressure: "normal" } },
  hostSignals: async () => signals.current,
});
try {
  await until(async () => (await queueOf()).hold?.reason === "load");
  assert.deepEqual((await queueOf()).hold, { reason: "load", loadPerCore: 0.9, limit: 0.7, text: "Held: load 0.90 for each core, limit 0.70" });
  await delay(200);
  assert.deepEqual(await runs(), []);
  signals.current = { loadAverage: 1.2, cores: 12, memoryPressure: "warn" };
  await until(async () => (await queueOf()).hold?.reason === "memory");
  assert.equal((await queueOf()).hold.text, "Held: memory pressure warn, limit normal");
  assert.deepEqual(await runs(), []);
  signals.current = { loadAverage: 3.6, cores: 12, memoryPressure: "normal" };
  await until(async () => (await runs()).length === 1);
  await until(async () => (await queueOf()).hold === null);
  const holds = (await queueOf()).holds;
  assert.deepEqual(holds.map((period) => [period.reason, period.endedAt >= period.startedAt]), [["load", true], ["memory", true]]);
  assert.deepEqual(JSON.parse(readFileSync("queue-holds.json", "utf8")).periods, holds);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /Queue held: load 0\.90 for each core, limit 0\.70/,
    );
  }));
