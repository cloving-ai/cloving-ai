import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const control = `${queuePrelude}
const saved = () => JSON.parse(readFileSync("queue-commands.json", "utf8"));
const queue = async () => (await asked("queue")).queue;
const command = (name, commandId) => asked("queue-command", { command: name, commandId });
`;

await test("CLV-273 a resume clears a stop after three failures and the next cycle admits a ready ticket", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${control}
const prior = ["run-first", "run-second", "run-third"];
writeFileSync("queue-commands.json", JSON.stringify({ commands: [], failures: prior }));
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(async () => (await queue())?.state === "stopped");
  const stopped = await queue();
  assert.deepEqual(stopped.stop, { reason: "failure-limit" });
  assert.deepEqual(stopped.failedRunIds, prior);
  await delay(200);
  assert.equal((await runs()).length, 0);
  const resumed = await command("resume", "resume-one");
  assert.equal(resumed.kind, "queue-command", JSON.stringify(resumed));
  assert.equal(resumed.commandId, "resume-one");
  assert.equal(resumed.replayed, false);
  assert.equal(resumed.queue.state, "running");
  assert.deepEqual(resumed.queue.failedRunIds, []);
  assert.deepEqual(saved().failures, []);
  await until(() => existsSync("input-CLV-900"));
  assert.equal((await runs()).length, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stderr.split("Queue stopped:").length,
      2,
      result.stderr,
    );
  }));

await test("CLV-273 a drain lets the run in work end, admits no new run and records queue-drained once", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${control}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(() => existsSync("input-CLV-900"));
  const draining = await command("drain", "drain-one");
  assert.equal(draining.kind, "queue-command", JSON.stringify(draining));
  assert.equal(draining.queue.state, "draining");
  assert.equal(draining.queue.busy, 1);
  assert.equal(typeof draining.queue.drain.startedAt, "number");
  assert.equal(draining.queue.drain.drainedAt, null);
  assert.equal((await asked("status")).queue.state, "draining");
  writeFileSync("ready", "CLV-901");
  writeFileSync("outcome-CLV-900", "handoff_requested");
  await until(async () => (await shown((await runs())[0].runId)).state === "completed");
  await until(() => typeof saved().drain?.drainedAt === "number");
  await delay(300);
  const drained = await queue();
  assert.equal(drained.state, "drained");
  assert.equal(drained.busy, 0);
  assert.equal(drained.drain.drainedAt, saved().drain.drainedAt);
  assert.deepEqual((await asked("status")).queue, drained);
  assert.equal(existsSync("input-CLV-901"), false);
  assert.equal((await runs()).length, 1);
  const resumed = await command("resume", "resume-two");
  assert.equal(resumed.queue.state, "running");
  assert.equal(resumed.queue.drain, null);
  assert.equal(saved().drain, undefined);
  await until(() => existsSync("input-CLV-901"));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.stderr.split("\n").filter((line) => line.startsWith("Queue ")),
      ["Queue drained"],
    );
  }));

await test("CLV-273 a drain stays in place after a restart and a reset of the queue ends it", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.run(`${control}
const daemon = await launched();
try {
  const drained = await command("drain", "drain-before-restart");
  assert.equal(drained.queue.state, "drained");
  await until(() => typeof saved().drain?.drainedAt === "number");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(first.status, 0, first.stderr);
    const second = await consumer.run(`${control}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await delay(300);
  assert.equal((await queue()).state, "drained");
  assert.equal((await runs()).length, 0);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr.includes("Queue drained"), false);
    const third = await consumer.run(`${control}
const daemon = await launched({ resetQueue: true });
try {
  await until(() => existsSync("input-CLV-900"));
  assert.equal(saved().drain, undefined);
  assert.equal((await queue()).state, "running");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(third.status, 0, third.stderr);
  }));
