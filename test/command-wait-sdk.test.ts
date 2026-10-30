import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import {
  commandWaitWorkflow,
  commandWaitPrelude,
} from "./command-wait-sdk-fixture.ts";

await test("CLV-237 a pause before the first opening leaves the step unfinished until resume", () =>
  withConsumer(commandWaitWorkflow, async (consumer) => {
    const result = await consumer.run(`${commandWaitPrelude}
writeFileSync("responses", JSON.stringify([{ ready: true, value: { approved: true } }]));
const service = await waitHost();
const open = ports.commandWait.open;
const attempts = [];
const changeRun = async (request, command) => {
  const run = (await ports.state()).runs[request.runId];
  assert.equal((await asked("run-command", { runId: request.runId, command, expectedRevision: run.revision, commandId: command })).kind, "run-command");
};
ports.commandWait.open = async request => {
  attempts.push(request);
  if (attempts.length === 1) await changeRun(request, "pause");
  if (attempts.length === 2) {
    assert.equal((await ports.state()).runs[request.runId].status, "paused");
    assert.equal(await currentWait(request.runId), undefined);
    assert.equal(lines("command-calls").length, 0);
    assert.equal((await eventsOf(request.runId)).filter(event => event.eventType === "step_completed").length, 0);
    mock.timers.setTime(initialTime + 60000);
    await changeRun(request, "resume");
  }
  const receipt = await open(request);
  if (attempts.length === 1) assert.deepEqual(receipt, { kind: "rejected", reason: "command-wait-run-not-running" });
  return receipt;
};
try {
  const runId = await submitted("pause-opening");
  await until(async () => (await tagged()).some(run => run.run === runId));
  const sdkId = await worldId(runId);
  await until(async () => (await getRun(sdkId).status) === "completed");
  const output = await getRun(sdkId).returnValue;
  assert.deepEqual(JSON.parse(output.promotionId), { kind: "ready", value: { approved: true } });
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
  const wait = await currentWait(runId);
  assert.equal(wait.startedAt, initialTime + 60000);
  assert.equal(wait.deadline, wait.startedAt + 2592000000);
  assert.equal(wait.checkCount, 1);
  assert.equal(lines("command-calls").length, 1);
  assert.deepEqual((await asked("status", { runId })).run.budget, { limit: 1, spent: 0 });
  assert.equal((await eventsOf(runId)).filter(event => event.eventType === "step_retrying").length, 0);
  print({ resumed: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ resumed: true }]);
  }));

await test("CLV-237 compiled declared wait suspends, survives two restarts and returns ready with the original deadline", () =>
  withConsumer(commandWaitWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "command-wait-suspended",
      `${commandWaitPrelude}
writeFileSync("responses", JSON.stringify([{ ready: false }, { ready: false }, { ready: true, value: { approved: true } }]));
await waitBarrier();
await waitHost();
await submitted("command-wait");
await new Promise(() => undefined);
`,
    );
    assert.equal(first.status, null, first.stderr);
    assert.equal(first.lines.length, 1, first.stderr);
    const second = await consumer.runUntil(
      "command-wait-suspended",
      `${commandWaitPrelude}
mock.timers.setTime(initialTime + 3600000);
await waitBarrier(2);
await waitHost();
await new Promise(() => undefined);
`,
    );
    assert.equal(second.status, null, second.stderr);
    assert.equal(second.lines.length, 1, second.stderr);
    const result = await consumer.run(`${commandWaitPrelude}
mock.timers.setTime(initialTime + 7200000);
const service = await waitHost();
try {
  await completed({ kind: "ready", value: { approved: true } }, 3);
  const events = await eventsOf(saved().runId);
  assert.equal(events.filter(event => event.eventType === "wait_created").length, 2);
  assert.equal(events.filter(event => event.eventType === "wait_completed").length, 2);
  assert.equal(events.filter(event => event.eventType === "step_retrying").length, 0);
  print({ ready: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ ready: true }]);
  }));

await test("CLV-237 compiled wait wakes at its deadline when the next check is later and starts no command", () =>
  withConsumer(commandWaitWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "command-wait-suspended",
      `${commandWaitPrelude}
registration.manifest.commandWaits["team-review"] = { command: "review-state", maximumWaitSeconds: 60, pollEverySeconds: 60 };
writeFileSync("responses", JSON.stringify([{ ready: false }]));
await waitBarrier();
await waitHost();
const report = ports.reportEffect;
ports.reportEffect = async result => { mock.timers.setTime(initialTime + 30000); return await report(result); };
await submitted("timeout");
await new Promise(() => undefined);
`,
    );
    assert.equal(first.status, null, first.stderr);
    assert.equal(first.lines.length, 1, first.stderr);
    const result = await consumer.run(`${commandWaitPrelude}
registration.manifest.commandWaits["team-review"] = { command: "review-state", maximumWaitSeconds: 60, pollEverySeconds: 60 };
mock.timers.setTime(initialTime + 60000);
const service = await waitHost();
try {
  await completed({ kind: "timed-out", reason: "command-wait-timeout" }, 1);
  print({ timeout: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ timeout: true }]);
  }));

await test("CLV-237 a crash before timer persistence cannot move the command wait deadline", () =>
  withConsumer(commandWaitWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "before-command-wait-timer",
      `${commandWaitPrelude}
registration.manifest.commandWaits["team-review"] = { command: "review-state", maximumWaitSeconds: 60, pollEverySeconds: 60 };
writeFileSync("responses", JSON.stringify([{ ready: false }]));
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType === "wait_created") {
    const runId = (await taggedRun(given[0])).runId;
    writeFileSync("wait-checkpoint", JSON.stringify({ runId, sdkId: given[0], deadline: (await currentWait(runId)).deadline, now: initialTime }));
    await halt("before-command-wait-timer");
  }
  return await create(...given);
};
await waitHost();
await submitted("timer-gap");
await new Promise(() => undefined);
`,
    );
    assert.equal(first.status, null, first.stderr);
    assert.equal(first.lines.length, 1, first.stderr);
    const result = await consumer.run(`${commandWaitPrelude}
registration.manifest.commandWaits["team-review"] = { command: "review-state", maximumWaitSeconds: 60, pollEverySeconds: 60 };
mock.timers.setTime(initialTime + 120000);
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType === "wait_created") assert.equal(given[1].eventData.resumeAt.getTime(), saved().deadline);
  return await create(...given);
};
const service = await waitHost();
try {
  await completed({ kind: "timed-out", reason: "command-wait-timeout" }, 1);
  print({ deadlinePreserved: true });
} finally { await commands.close(); await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ deadlinePreserved: true }]);
  }));
