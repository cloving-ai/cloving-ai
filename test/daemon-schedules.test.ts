import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { queuePrelude } from "./daemon-queue-fixture.ts";

const workflow = `
export async function develop(input) {
  "use workflow";
  return { kind: "blocked", reason: input.input.reason };
}
`;

const schedulePrelude = `${queuePrelude}
let now = 0;
const scheduledDaemon = (overrides = {}) => launched({ queueMilliseconds: undefined, scheduleClock: () => now,
  declarations: [{ workflowId: "review-queue", functionName: "review", effectLimit: 1, capabilities: ["claude", "github"],
    input: { maximumBytes: 1000, fields: { reason: { type: "string" } } },
    schedule: { everySeconds: 300, input: { reason: "scheduled scan" } } }],
  manifests: { ...settings.manifests, review: settings.manifests.developTicket },
  workflows: { ...settings.workflows, review: workflows.develop },
  ...overrides,
});
`;

await test("CLV-242 a stopped daemon schedule survives restart and resumes with a new slot", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${schedulePrelude}
let daemon = await scheduledDaemon();
const schedule = async () => (await asked("schedule", { action: "list" })).schedules[0];
try {
  for (let slot = 1; slot <= 3; slot++) {
    now = slot * 300000;
    await until(async () => (await schedule()).failuresInRow === slot);
  }
  const stopped = await schedule();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.nextAt, null);
  assert.equal(stopped.activeRunId, null);
  assert.equal(stopped.failedRunIds.length, 3);
  await daemon.close();
  now = 1500000;
  daemon = await scheduledDaemon();
  assert.deepEqual(await schedule(), stopped);
  assert.equal((await runs()).length, 3);
  await asked("schedule", { action: "resume", workflowId: "review-queue" });
  assert.equal((await schedule()).nextAt, 1800000);
  now = 1799999;
  await delay(300);
  assert.equal((await runs()).length, 3);
  now = 1800000;
  await until(async () => (await runs()).length === 4);
  assert.ok((await shown(runIdentity("schedule:review-queue:4"))));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-242 a paused daemon schedule remains paused after restart and interval change", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${schedulePrelude}
let daemon = await scheduledDaemon();
await asked("schedule", { action: "pause", workflowId: "review-queue" });
await daemon.close();
now = 900000;
daemon = await scheduledDaemon({ schedules: { "review-queue": { everySeconds: 60, input: { reason: "changed" } } } });
try {
  await delay(300);
  const paused = (await asked("schedule", { action: "list" })).schedules[0];
  assert.equal(paused.state, "paused");
  assert.equal(paused.everySeconds, 60);
  assert.equal(paused.lastSlot, 0);
  assert.equal(paused.nextAt, null);
  assert.equal((await runs()).length, 0);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-179 the daemon starts a declared workflow at the interval boundary", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${schedulePrelude}
const daemon = await scheduledDaemon();
try {
  assert.equal((await runs()).length, 0);
  now = 299999;
  await delay(300);
  assert.equal((await runs()).length, 0);
  now = 300000;
  const scheduled = await until(async () => (await runs())[0]);
  assert.equal(scheduled.runId, runIdentity("schedule:review-queue:1"));
  assert.equal(scheduled.workflowId, "review-queue");
  assert.deepEqual(scheduled.input, { reason: "scheduled scan" });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-179 a setting entry replaces the declaration schedule and input", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${schedulePrelude}
const daemon = await scheduledDaemon({ schedules: { "review-queue": { everySeconds: 60, input: { reason: "override" } } } });
try {
  now = 60000;
  const scheduled = await until(async () => (await runs())[0]);
  assert.deepEqual(scheduled.input, { reason: "override" });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

const waitingWorkflow = `
import { sleep } from "workflow";
export async function develop() {
  "use workflow";
  await sleep("1d");
  return { kind: "blocked", reason: "finished" };
}
`;

await test("CLV-179 an active scheduled run skips the next slot and records an event", () =>
  withConsumer(waitingWorkflow, async (consumer) => {
    const result = await consumer.run(`${schedulePrelude}
const daemon = await scheduledDaemon();
try {
  now = 300000;
  const first = await until(async () => (await runs())[0]);
  now = 600000;
  const skipped = async () => (await asked("events", { after: 0, limit: 1000, runId: first.runId })).events.find(event => event.type === "schedule.skipped");
  await until(async () => (await runs()).length > 1 || await skipped());
  assert.equal((await runs()).length, 1);
  assert.deepEqual((await skipped()).payload, { slot: "2", workflowId: "review-queue" });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-179 restarting mid-interval preserves the next slot and command identity", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${schedulePrelude}
const first = await scheduledDaemon();
now = 300000;
await until(async () => (await shown(runIdentity("schedule:review-queue:1")))?.state === "completed");
now = 450000;
await first.close();
const restarted = await scheduledDaemon();
try {
  await delay(300);
  assert.equal((await runs()).length, 1);
  now = 600000;
  await until(async () => (await runs()).length === 2);
  const ids = (await runs()).map(run => run.runId).sort();
  assert.deepEqual(ids, [1, 2].map(slot => runIdentity("schedule:review-queue:" + slot)).sort());
} finally { await restarted.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-179 process termination retains the active run and the next scheduled boundary", () =>
  withConsumer(waitingWorkflow, async (consumer) => {
    const killed = await consumer.runUntil(
      "scheduled-slot",
      `${schedulePrelude}
await scheduledDaemon();
now = 300000;
await until(async () => (await runs()).length === 1);
await until(() => !JSON.parse(readFileSync("state/schedules.json", "utf8"))["review-queue"].pending);
await halt("scheduled-slot");
`,
    );
    assert.equal(killed.status, null);
    const result = await consumer.run(`${schedulePrelude}
now = 450000;
const daemon = await scheduledDaemon();
try {
  assert.equal((await runs()).length, 1);
  now = 600000;
  const events = await until(async () => {
    const events = (await asked("events", { after: 0, limit: 1000 })).events;
    return events.some(event => event.type === "schedule.skipped") ? events : undefined;
  });
  assert.equal(events.filter(event => event.type === "run.created").length, 1);
  assert.equal(events.find(event => event.type === "schedule.skipped").payload.slot, "2");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-179 corrupt schedule state releases the service so startup can be retried", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${schedulePrelude}
const { mkdir } = await import("node:fs/promises");
await mkdir("state");
writeFileSync("state/schedules.json", "null");
await assert.rejects(scheduledDaemon(), /invalid-schedule-state/);
writeFileSync("state/schedules.json", "{}");
const daemon = await scheduledDaemon();
try { assert.equal((await runs()).length, 0); }
finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
