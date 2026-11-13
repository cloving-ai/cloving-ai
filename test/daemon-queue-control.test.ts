import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-373 a legacy drain waits for a retained unrelated run after the journal moves to queue storage", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
settings.declarations.push({ ...settings.declarations[0], workflowId: "review-corpus", queue: false });
let daemon = await launched({ queueMilliseconds: undefined });
try {
  const reply = await submitted("unrelated-retained", { workflowId: "review-corpus", submission: { ticket: "CLV-901" } });
  assert.equal(reply.kind, "run-admitted", JSON.stringify(reply));
  await until(() => existsSync("input-CLV-901"));
} finally { await daemon.close(); }
writeFileSync("queue-commands.json", JSON.stringify({ commands: [], failures: [], drain: { startedAt: 1, drainedAt: null }, controls: [{ command: "drain", commandId: "legacy-drain" }] }));
daemon = await launched();
try {
  const first = (await asked("status")).queue.nextCheckAt;
  await until(async () => (await asked("status")).queue.nextCheckAt !== first);
  const status = await asked("status");
  assert.equal(status.queue.state, "draining");
  assert.equal(status.queue.drain.drainedAt, null);
  assert.equal(status.queue.busy, 0);
  assert.equal(status.runs.filter(run => run.state === "running").length, 1);
  assert.equal(existsSync("queue-commands.json"), false);
  const replay = await asked("queue-command", { command: "drain", commandId: "legacy-drain" });
  assert.equal(replay.replayed, true);
  writeFileSync("outcome-CLV-901", "handoff_requested");
  await until(async () => (await asked("status")).queue.state === "drained");
  assert.equal((await runs()).length, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

const control = `${queuePrelude}
const saved = () => JSON.parse(readFileSync("queues/develop/queue-commands.json", "utf8"));
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
  const draining = await command("drain", "drain-before-restart");
  assert.equal(
    draining.queue.state,
    draining.queue.drain.drainedAt === null ? "draining" : "drained",
  );
  await until(() => typeof saved().drain?.drainedAt === "number");
  await until(async () => (await queue()).state === "drained");
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

await test("CLV-283 a queue command right after the start gets the queue when the journal loads slowly", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${control}
const promises = (await import("node:fs/promises")).default;
const { syncBuiltinESMExports } = await import("node:module");
const reading = promises.readFile;
promises.readFile = (path, ...rest) =>
  String(path).endsWith("queue-commands.json")
    ? delay(200).then(() => reading(path, ...rest))
    : reading(path, ...rest);
syncBuiltinESMExports();
const daemon = await launched();
try {
  const draining = await command("drain", "drain-at-start");
  assert.equal(draining.kind, "queue-command", JSON.stringify(draining));
  assert.equal(typeof draining.queue.drain.startedAt, "number");
  assert.equal(typeof (await asked("status")).queue.state, "string");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-360 a drain finishes while another queue stays busy and resume changes only its queue", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(
      `${queuePrelude}
settings.declarations.push({ ...settings.declarations[0], workflowId: "triage-issue" });
const daemon = await launched({ queueMilliseconds: 100, concurrency: 4 });
const queues = async () => (await asked("status")).queues;
try {
  assert.equal((await submitted("manual-develop", { submission: { ticket: "CLV-900" } })).kind, "run-admitted");
  const duplicate = await submitted("duplicate-triage", { workflowId: "triage-issue", submission: { ticket: "CLV-900" } });
  assert.equal(duplicate.code, "ticket-active", JSON.stringify(duplicate));
  const manual = await submitted("manual-triage", { workflowId: "triage-issue", submission: { ticket: "CLV-901" } });
  assert.equal(manual.kind, "run-admitted", JSON.stringify(manual));
  await until(() => existsSync("input-CLV-900") && existsSync("input-CLV-901"));
  const drained = await asked("queue-command", { command: "drain", commandId: "drain-triage", workflowId: "triage-issue" });
  assert.equal(drained.queue.workflowId, "triage-issue");
  assert.equal(drained.queue.state, "draining");
  writeFileSync("outcome-CLV-901", "handoff_requested");
  await until(async () => (await queues()).find(queue => queue.workflowId === "triage-issue").state === "drained");
  assert.equal((await queues()).find(queue => queue.workflowId === "develop").busy, 1);
  writeFileSync("ready", "CLV-902");
  const resumed = await asked("queue-command", { command: "resume", commandId: "resume-triage", workflowId: "triage-issue" });
  assert.equal(resumed.queue.state, "running");
  await until(async () => (await runs()).length === 3);
  assert.equal((await queues()).find(queue => queue.workflowId === "develop").drain, null);
} finally { await daemon.close(); }
process.exit(0);
`,
      { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "4" },
    );
    assert.equal(result.status, 0, result.stderr);
  }));
