import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancellationPollingWorkflow,
  compiledPollingWorkflow,
  pollingPrelude,
} from "./command-polling-sdk-fixture.ts";
import { withConsumer, type Consumer } from "./world-host-fixture.ts";

async function persistedSleep(consumer: Consumer): Promise<void> {
  const result = await consumer.runUntil(
    "sleep-persisted",
    `${pollingPrelude}
writeFileSync("responses", JSON.stringify([false, true]));
await waitBarrier();
const service = await pollingHost();
await submitted("polling");
await new Promise(() => undefined);
`,
  );
  assert.equal(result.status, null, result.stderr);
  assert.equal(result.lines.length, 1, result.stderr);
}

async function resumedPolling(consumer: Consumer): Promise<void> {
  const result = await consumer.run(
    `${pollingPrelude}
const service = await pollingHost();
try {
  const checkpoint = await sameWait();
  assert.ok(Date.now() > Date.parse(checkpoint.wait.eventData.resumeAt));
  await completedPolling(checkpoint.runId);
  await verifiedChecks(checkpoint.runId, 2);
  await sameWait();
  const completed = (await eventsOf(checkpoint.runId)).filter(event => event.eventType === "wait_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].correlationId, checkpoint.wait.correlationId);
  print({ resumed: true });
} finally { await commands.close(); await service.close(); }
`,
    { CLOCK_OFFSET: "600000" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, [{ resumed: true }]);
}

await test("CLV-233 before-wake restart retains the sleep and replays one completed command before one new check", () =>
  withConsumer(compiledPollingWorkflow, async (consumer) => {
    await persistedSleep(consumer);
    const result = await consumer.run(
      `${pollingPrelude}
const world = await getWorld();
const register = world.registerHandler.bind(world);
world.registerHandler = (prefix, handler) => register(prefix, async request => {
  const response = await handler(request);
  writeFileSync("replayed-before-wake", "");
  return response;
});
const service = await pollingHost();
try {
  await until(() => existsSync("replayed-before-wake"));
  const checkpoint = await sameWait();
  assert.ok(Date.now() < Date.parse(checkpoint.wait.eventData.resumeAt));
  await verifiedChecks(checkpoint.runId, 1);
  assert.equal((await eventsOf(checkpoint.runId)).filter(event => event.eventType === "wait_completed").length, 0);
  assert.equal(await stateOf(checkpoint.runId), "running");
  print({ sleeping: true });
} finally { await commands.close(); await service.close(); }
`,
      { CLOCK_OFFSET: "59000" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ sleeping: true }]);
    await resumedPolling(consumer);
  }));

await test("CLV-233 overdue restart retains the sleep and replays one completed command before one new check", () =>
  withConsumer(compiledPollingWorkflow, async (consumer) => {
    await persistedSleep(consumer);
    await resumedPolling(consumer);
  }));

await test("CLV-233 a command result before its SDK checkpoint replays once into one sleep and one next check", () =>
  withConsumer(compiledPollingWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "command-before-checkpoint",
      `${pollingPrelude}
writeFileSync("responses", JSON.stringify([false, true]));
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType === "step_completed") {
    const runId = (await taggedRun(given[0])).runId;
    await verifiedChecks(runId, 1);
    const events = await eventsOf(runId);
    assert.equal(events.filter(event => event.eventType === "step_completed").length, 0);
    assert.equal(events.filter(event => event.eventType === "wait_created").length, 0);
    writeFileSync("command-checkpoint", JSON.stringify({ runId, sdkId: given[0], now: initialTime }));
    await halt("command-before-checkpoint");
  }
  return await create(...given);
};
const service = await pollingHost();
await submitted("checkpoint");
await new Promise(() => undefined);
`,
    );
    assert.equal(first.status, null, first.stderr);
    const second = await consumer.runUntil(
      "sleep-persisted",
      `${pollingPrelude}
mock.timers.setTime(initialTime + 3000);
await waitBarrier();
const service = await pollingHost();
await new Promise(() => undefined);
`,
    );
    assert.equal(second.status, null, second.stderr);
    assert.equal(second.lines.length, 1, second.stderr);
    await resumedPolling(consumer);
  }));

await test("CLV-233 dropping a sleeping run commits SDK cancellation and restart past wake dispatches no check or continuation", () =>
  withConsumer(cancellationPollingWorkflow, async (consumer) => {
    await persistedSleep(consumer);
    const cancelled = await consumer.run(`${pollingPrelude}
const service = await pollingHost();
try {
  const checkpoint = await sameWait();
  const runId = checkpoint.runId;
  const reply = await asked("run-command", { command: "drop", runId, expectedRevision: (await shown(runId)).revision, commandId: "drop-polling" });
  assert.equal(reply.kind, "run-command");
  assert.equal(reply.committed.state, "cancelled");
  await until(async () => (await getRun(checkpoint.sdkId).status) === "cancelled");
  assert.equal(await stateOf(runId), "cancelled");
  await verifiedChecks(runId, 1);
  print({ cancelled: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const restarted = await consumer.run(
      `${pollingPrelude}
const service = await pollingHost();
try {
  const barrier = await start(workflows.queueBarrier, []);
  assert.equal(await barrier.returnValue, "queue-observed");
  const checkpoint = await sameWait();
  assert.ok(Date.now() > Date.parse(checkpoint.wait.eventData.resumeAt));
  assert.equal(await getRun(checkpoint.sdkId).status, "cancelled");
  assert.equal(await stateOf(checkpoint.runId), "cancelled");
  await verifiedChecks(checkpoint.runId, 1);
  const events = await eventsOf(checkpoint.runId);
  assert.equal(events.filter(event => event.eventType === "run_cancelled").length, 1);
  assert.equal(events.filter(event => event.eventType === "wait_completed").length, 0);
  assert.equal(events.filter(event => event.eventType === "run_completed").length, 0);
  assert.equal((await ports.state()).intents.some(intent => intent.kind === "continue-run"), false);
  print({ cancelled: true });
} finally { await commands.close(); await service.close(); }
`,
      { CLOCK_OFFSET: "600000" },
    );
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(restarted.lines, [{ cancelled: true }]);
  }));
