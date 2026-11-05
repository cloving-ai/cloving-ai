import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-298 a stalled pool check in the daemon logs threadpool-stalled, shows the stall in the status and the daemon keeps running", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
settings.queueMilliseconds = undefined;
const held = setTimeout(() => undefined, 60000);
const daemon = await launched({
  threadPool: { intervalMilliseconds: 20, deadlineMilliseconds: 50, check: () => new Promise(() => undefined) },
});
try {
  const stalled = await until(async () => (await asked("status")).threadPool);
  assert.equal(stalled.result, "stalled");
  assert.ok(stalled.milliseconds >= 50);
  assert.ok(stalled.resources.Timeout >= 1);
  await delay(200);
  const later = await asked("status");
  assert.deepEqual(later.threadPool, stalled);
  assert.deepEqual(later.runs, []);
} finally { clearTimeout(held); await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stderr.match(
        /^threadpool-stalled ms=\d+ resources=\S*Timeout:\d+\S*$/gm,
      )?.length,
      1,
      result.stderr,
    );
  }));

await test("CLV-298 the daemon status has no pool check field before the first check ends", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
settings.queueMilliseconds = undefined;
const daemon = await launched({
  threadPool: { intervalMilliseconds: 60000, deadlineMilliseconds: 60000, check: () => new Promise(() => undefined) },
});
try {
  assert.equal(Object.hasOwn(await asked("status"), "threadPool"), false);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
