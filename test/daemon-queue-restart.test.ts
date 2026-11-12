import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const blockedAfterRestart = `${queuePrelude}
writeFileSync("outcome-CLV-900", "blocked");
writeFileSync("ready", "CLV-901");
const daemon = await launched();
try {
  const [prior] = await runs();
  await until(async () => (await shown(prior.runId)).state === "completed");
  await until(() => existsSync("input-CLV-901"));
  assert.equal((await runs()).length, 2);
  print({ runId: prior.runId });
} finally { await daemon.close(); }
process.exit(0);
`;

await test("CLV-131 an active queue run survives a crash and its blocked outcome releases the restarted queue", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "active",
      `${queuePrelude}
writeFileSync("ready", "CLV-900");
await launched();
await until(() => existsSync("input-CLV-900"));
assert.equal(commands().length, 1);
await halt("active");
`,
    );
    assert.deepEqual(first.lines, [{ boundary: "active" }], first.stderr);
    const second = await consumer.run(blockedAfterRestart);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /Queue run ended blocked: run-.*; continuing/);
  }));

await test("CLV-084 a command persisted before a lost admission reply recovers its run on restart", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "lost-reply",
      `${queuePrelude}
await launched({ queueMilliseconds: undefined });
writeFileSync("queue-commands.json", JSON.stringify(["lost-admission"]));
const reply = await submitted("lost-admission");
assert.equal(reply.runId, runIdentity("lost-admission"));
await until(() => existsSync("input-CLV-900"));
await halt("lost-reply");
`,
    );
    assert.deepEqual(first.lines, [{ boundary: "lost-reply" }], first.stderr);
    const second = await consumer.run(blockedAfterRestart);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /Queue run ended blocked: run-.*; continuing/);
  }));

await test("CLV-084 a handled blocked run is removed so the next daemon can admit a ready ticket", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(() => existsSync("input-CLV-900"));
  writeFileSync("ready", "");
  writeFileSync("outcome-CLV-900", "blocked");
  const run = await until(async () => (await runs())[0]);
  await until(async () => (await shown(run.runId)).state === "completed");
  await until(() => commands().length === 0);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /Queue run ended blocked: run-.*; continuing/);
    const second = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-901");
const daemon = await launched();
try { await until(() => existsSync("input-CLV-901")); }
finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr.includes("Queue stopped:"), false);
  }));

await test("CLV-084 a command with no run is removed on restart before the next submission", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("queue-commands.json", JSON.stringify(["never-admitted"]));
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(() => existsSync("input-CLV-900"));
  assert.equal(commands().includes("never-admitted"), false);
  assert.equal(commands().length, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-360 the only queue takes the legacy journal and holds and keeps its drain", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const startedAt = Date.now() - 1000;
writeFileSync("queue-commands.json", JSON.stringify({ commands: [], failures: [], drain: { startedAt, drainedAt: null }, controls: [{ command: "drain", commandId: "legacy-drain" }] }));
const holds = { periods: [{ reason: "load", startedAt: startedAt - 1000, endedAt: startedAt }], open: null, cutAt: startedAt - 1000 };
writeFileSync("queue-holds.json", JSON.stringify(holds));
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(async () => (await asked("status")).queue?.state === "drained");
  const status = await asked("status");
  assert.equal(status.queue.drain.startedAt, startedAt);
  assert.deepEqual(status.queues, [status.queue]);
  assert.deepEqual(await runs(), []);
  assert.equal(existsSync("queue-commands.json"), false);
  assert.equal(existsSync("queue-holds.json"), false);
  const journal = JSON.parse(readFileSync("queues/develop/queue-commands.json", "utf8"));
  assert.equal(journal.drain.startedAt, startedAt);
  assert.deepEqual(journal.controls, [{ command: "drain", commandId: "legacy-drain" }]);
  assert.deepEqual(status.queue.holds, holds.periods);
  assert.deepEqual(JSON.parse(readFileSync("queues/develop/queue-holds.json", "utf8")).periods, holds.periods);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-360 startup removes a legacy pending submission before gap checks", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("queue-submission", "");
const daemon = await launched();
try {
  assert.equal(existsSync("queue-submission"), false);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-360 restart resume clears every queue drain and keeps each failure streak", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
import { mkdirSync } from "node:fs";
settings.declarations.push({ ...settings.declarations[0], workflowId: "triage-issue" });
for (const id of ["develop", "triage-issue"]) {
  mkdirSync("queues/" + id, { recursive: true });
  writeFileSync("queues/" + id + "/queue-commands.json", JSON.stringify({ commands: [], failures: ["failed-" + id], drain: { startedAt: 1, drainedAt: 2 } }));
}
writeFileSync("resume-queue", "");
let daemon = await launched();
try {
  await until(async () => (await asked("status")).queues.every(queue => queue.state === "running"));
  assert.equal(existsSync("resume-queue"), false);
} finally { await daemon.close(); }
daemon = await launched();
try {
  const status = await asked("status");
  assert.deepEqual(status.queues.map(queue => [queue.workflowId, queue.state, queue.failedRunIds]), [["develop", "running", ["failed-develop"]], ["triage-issue", "running", ["failed-triage-issue"]]]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-360 a later queue startup failure stops earlier queue timers", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
import { mkdirSync } from "node:fs";
import timers from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
const sleeping = timers.setTimeout;
const signals = [];
timers.setTimeout = (milliseconds, value, options) => {
  if (milliseconds === 12345) signals.push(options.signal);
  return sleeping(milliseconds, value, options);
};
syncBuiltinESMExports();
settings.declarations.push({ ...settings.declarations[0], workflowId: "triage-issue" });
mkdirSync("queues", { recursive: true });
writeFileSync("queues/triage-issue", "blocked folder");
await assert.rejects(startDaemon({ ...settings, queueMilliseconds: 12345, readyCommand: [process.execPath, "-e", 'process.stdout.write("[]")'] }));
await sleeping(100);
print({ observed: signals.length > 0, aborted: signals.every(signal => signal.aborted) });
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ observed: true, aborted: true }]);
  }));
