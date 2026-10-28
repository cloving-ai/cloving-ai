import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capacityPollingWorkflow,
  compiledPollingWorkflow,
  pollingPrelude,
} from "./command-polling-sdk-fixture.ts";
import { withConsumer, type Consumer } from "./world-host-fixture.ts";

async function twoPendingChecks(
  consumer: Consumer,
  effectLimit = 30,
): Promise<void> {
  const first = await consumer.runUntil(
    "sleep-persisted",
    `${pollingPrelude}
registration.effectLimit = ${String(effectLimit)};
writeFileSync("responses", JSON.stringify([false, false, true]));
await waitBarrier();
const service = await pollingHost();
await submitted("polling");
await new Promise(() => undefined);
`,
  );
  assert.equal(first.status, null, first.stderr);
  assert.equal(first.lines.length, 1, first.stderr);
  const second = await consumer.runUntil(
    "sleep-persisted",
    `${pollingPrelude}
registration.effectLimit = ${String(effectLimit)};
mock.timers.setTime(initialTime + 600000);
await waitBarrier(2);
const service = await pollingHost();
await new Promise(() => undefined);
`,
  );
  assert.equal(second.status, null, second.stderr);
  assert.equal(second.lines.length, 1, second.stderr);
}

await test("CLV-233 compiled polling ready on its immediate first command continues once without a timer", () =>
  withConsumer(compiledPollingWorkflow, async (consumer) => {
    const result = await consumer.run(`${pollingPrelude}
writeFileSync("responses", JSON.stringify([true]));
const service = await pollingHost();
try {
  const runId = await submitted("immediate");
  await completedPolling(runId);
  await verifiedChecks(runId, 1);
  const events = await eventsOf(runId);
  assert.equal(events.filter(event => event.eventType === "wait_created").length, 0);
  assert.equal(events.filter(event => event.eventType === "step_completed").length, 1);
  print({ ready: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ ready: true }]);
  }));

for (const [capability, method, target] of [
  ["fake-harness", "run-turn", "workspace/unrelated"],
  ["github", "read-issue", "issue:synthetic"],
  ["command", "run:approval-status", "approval-status"],
])
  await test(`CLV-233 four sleeping command pollers release default shared capacity for ${String(capability)}`, () =>
    withConsumer(capacityPollingWorkflow, async (consumer) => {
      const result = await consumer.run(`${pollingPrelude}
writeFileSync("responses", JSON.stringify([false]));
const other = { ...registration, workflowId: "unrelated", effectLimit: 1, manifest: { ...registration.manifest, capabilities: [${JSON.stringify(capability)}] }, resolver: { ...registration.resolver, resolve: async () => ({ kind: "resolved", input: { cycleId: "unrelated-cycle", input: { capability: ${JSON.stringify(capability)}, method: ${JSON.stringify(method)}, target: ${JSON.stringify(target)} } } }) } };
const active = new Set();
let peak = 0;
const tracked = {
  deliver: async (intent, signal) => {
    active.add(intent.operationId);
    peak = Math.max(peak, active.size);
    assert.ok(active.size <= 4);
    if (intent.capability === "command") return await commands.deliver(intent, signal);
    active.delete(intent.operationId);
    return { kind: "completed", receipt: "synthetic", result: "bounded response" };
  },
  reconcile: (intent, signal) => intent.capability === "command" ? commands.reconcile(intent, signal) : Promise.resolve({ kind: "absent" }),
};
const service = await pollingHost({ registrations: [registration, other], destination: tracked, resolveWorkflow: async intent => (await ports.workflow.id(intent.runId)) === "unrelated" ? workflows.unrelated : workflows.approval });
const report = ports.reportEffect;
ports.reportEffect = async result => { active.delete(result.operationId); return await report(result); };
try {
  const runs = await Promise.all(Array.from({ length: 4 }, (_, index) => submitted("poller-" + index)));
  await until(async () => (await tagged()).filter(run => runs.includes(run.run)).length === 4);
  await until(async () => (await Promise.all(runs.map(eventsOf))).every(events => events.some(event => event.eventType === "wait_created")));
  for (const runId of runs) await verifiedChecks(runId, 1);
  assert.equal(active.size, 0);
  const started = await asked("run", { workflowId: "unrelated", source: "prompt", submission: { prompt: "unrelated work" }, commandId: "unrelated" });
  assert.equal(started.kind, "run-admitted");
  await until(async () => (await stateOf(started.runId)) === "completed");
  const otherRun = await shown(started.runId);
  assert.deepEqual(otherRun.budget, { limit: 1, spent: 1 });
  assert.equal(otherRun.effects[0].state, "completed");
  assert.equal((await getRun(await sdkId(started.runId)).returnValue).promotionId, "completed");
  for (const runId of runs) {
    await verifiedChecks(runId, 1);
    const events = await eventsOf(runId);
    assert.equal(events.filter(event => event.eventType === "wait_created").length, 1);
    assert.equal(events.filter(event => event.eventType === "wait_completed").length, 0);
    const wait = events.find(event => event.eventType === "wait_created");
    assert.ok(Date.now() < wait.eventData.resumeAt.getTime());
  }
  assert.ok(peak >= 1 && peak <= 4);
  assert.equal(active.size, 0);
  print({ dispatched: true });
} finally { await commands.close(); await service.close(); }
`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines, [{ dispatched: true }]);
    }));

await test("CLV-233 compiled pending pending ready uses three distinct sequential commands, two durable timers and three units", () =>
  withConsumer(compiledPollingWorkflow, async (consumer) => {
    await twoPendingChecks(consumer);
    const result = await consumer.run(`${pollingPrelude}
mock.timers.setTime(initialTime + 1200000);
const service = await pollingHost();
try {
  const runId = saved().runId;
  assert.equal(await sdkId(runId), saved().sdkId);
  await completedPolling(runId);
  await verifiedChecks(runId, 3);
  const events = await eventsOf(runId);
  assert.deepEqual(events.filter(event => ["step_completed", "wait_created", "wait_completed"].includes(event.eventType)).map(event => event.eventType), ["step_completed", "wait_created", "wait_completed", "step_completed", "wait_created", "wait_completed", "step_completed"]);
  print({ ready: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ ready: true }]);
  }));

await test("CLV-233 compiled polling refuses its third check at a budget of two without another process or timer", () =>
  withConsumer(compiledPollingWorkflow, async (consumer) => {
    await twoPendingChecks(consumer, 2);
    const result = await consumer.run(`${pollingPrelude}
registration.effectLimit = 2;
mock.timers.setTime(initialTime + 1200000);
const service = await pollingHost();
try {
  const runId = saved().runId;
  await until(async () => (await stateOf(runId)) === "completed");
  assert.deepEqual(await getRun(await sdkId(runId)).returnValue, { kind: "blocked", cycleId: "approval-cycle", reason: "budget-exhausted", evidenceId: "approval-status" });
  const run = await shown(runId);
  assert.deepEqual(run.budget, { limit: 2, spent: 2 });
  assert.equal(checks(runId).length, 2);
  assert.deepEqual(run.effects.map(effect => effect.state), ["completed", "completed", "refused"]);
  assert.equal(run.effects[2].reason, "budget-exhausted");
  const events = await eventsOf(runId);
  assert.equal(events.filter(event => event.eventType === "wait_created").length, 2);
  assert.equal(events.filter(event => event.eventType === "wait_completed").length, 2);
  assert.equal(events.filter(event => event.eventType === "step_completed").length, 3);
  print({ refused: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ refused: true }]);
  }));
