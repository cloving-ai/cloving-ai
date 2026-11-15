import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const limitsPrelude = `${queuePrelude}
writeFileSync("next.mjs", \`const skipped = (process.env.CLOVING_SKIP_TICKETS ?? "").split(" ");
const ticket = ["900", "901", "902", "903"].find(id => !skipped.includes(id));
if (ticket) process.stdout.write(ticket);\`);
writeFileSync("reload.mjs", 'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(process.argv[2], "utf8"));');
const bundleDigest = "a".repeat(64);
const reloadCommand = [process.execPath, directory + "/reload.mjs", directory + "/reload.json"];
const reloaded = (queueLimits) => {
  writeFileSync("reload.json", JSON.stringify({ bundleDigest, manifests: settings.manifests, declarations: settings.declarations, workflowRefusals: [], turnSettings: { profiles: {}, fallbackModels: [], tokenPrices: {} }, settingDigests: { "queue.lanes": String(queueLimits?.lanes) }, queueLimits }));
  return asked("reload");
};
const queueOf = async () => (await asked("status")).queue;
const loadBundle = () => Promise.resolve({ workflows: settings.workflows, handler: POST });
`;

await test("CLV-309 a lane change from 2 to 3 and a reload start a third run with no restart", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${limitsPrelude}
const daemon = await launched({ queueLanes: 2, reloadCommand, loadBundle, settingDigests: { "queue.lanes": "2" } });
try {
  await until(async () => (await runs()).length === 2);
  await delay(300);
  assert.equal((await runs()).length, 2);
  const reply = await reloaded({ lanes: 3, workingLanes: 3 });
  assert.deepEqual([reply.status, reply.reloadedFields, reply.restartFields], ["reloaded", ["queue.lanes"], []]);
  await until(async () => (await runs()).length === 3);
  assert.equal((await queueOf()).lanes, 3);
  assert.equal((await submitted("full", { submission: { ticket: "903" } })).code, "workflow-active");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-309 fewer lanes after a reload stop new starts and keep the active runs", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${limitsPrelude}
const daemon = await launched({ queueLanes: 2, reloadCommand, loadBundle, settingDigests: { "queue.lanes": "2" } });
try {
  await until(async () => (await runs()).length === 2);
  await reloaded({ lanes: 1, workingLanes: 1 });
  writeFileSync("outcome-900", "handoff_requested");
  await until(async () => (await runs()).filter((run) => run.state === "completed").length === 1);
  await delay(300);
  const states = (await runs()).map((run) => run.state).sort();
  assert.deepEqual(states, ["completed", "running"]);
  assert.equal((await queueOf()).lanes, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-309 a reload refuses queue limits that are not valid and keeps the lanes", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${limitsPrelude}
const daemon = await launched({ queueLanes: 2, reloadCommand, loadBundle, queueMilliseconds: 60000 });
try {
  for (const limits of [undefined, { lanes: 0, workingLanes: 0 }, { lanes: 17, workingLanes: 1 }, { lanes: 2, workingLanes: 3 }, { lanes: 2, workingLanes: 2, room: { maxLoadPerCore: 5, maxMemoryPressure: "normal" } }, { lanes: 2, workingLanes: 2, room: { maxLoadPerCore: 1, maxMemoryPressure: "critical" } }]) {
    const reply = await reloaded(limits);
    assert.equal(reply.code, "reload-failed", JSON.stringify(limits));
  }
  assert.equal((await queueOf()).lanes, 2);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-322 the status shows the effect capacity and the reserve, a reload applies a new reserve and refuses a reserve above 8", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${limitsPrelude}
const daemon = await launched({ queueLanes: 2, queueLimits: { lanes: 2, workingLanes: 2, reserved: 3 }, reloadCommand, loadBundle, queueMilliseconds: 60000 });
try {
  assert.deepEqual((await asked("status")).effectLeases, { capacity: 5, queueLimit: 2, reserved: 3 });
  const reply = await reloaded({ lanes: 4, workingLanes: 4, reserved: 0 });
  assert.equal(reply.status, "reloaded", JSON.stringify(reply));
  assert.deepEqual((await asked("status")).effectLeases, { capacity: 4, queueLimit: 4, reserved: 0 });
  assert.equal((await reloaded({ lanes: 4, workingLanes: 4, reserved: 9 })).code, "reload-failed");
  assert.deepEqual((await asked("status")).effectLeases, { capacity: 4, queueLimit: 4, reserved: 0 });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

const queuesPrelude = `${limitsPrelude}
const reloadedQueues = (queueLimits, queues) => {
  writeFileSync("reload.json", JSON.stringify({ bundleDigest, manifests: settings.manifests, declarations: settings.declarations, workflowRefusals: [], turnSettings: { profiles: {}, fallbackModels: [], tokenPrices: {} }, settingDigests: { queues }, queueLimits }));
  return asked("reload");
};
const started = { queueLanes: 2, queueLimits: { lanes: 2, workingLanes: 2, sources: { lanes: "declaration", workingLanes: "default" } }, queueIntervalSource: "declaration", reloadCommand, loadBundle, settingDigests: { queues: "restart-a:lanes-a" } };
`;

await test("CLV-359 a reload applies the queues lanes and working lanes at once with their sources", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuesPrelude}
const daemon = await launched(started);
try {
  await until(async () => (await runs()).length === 2);
  assert.deepEqual((await queueOf()).settings, {
    everySeconds: { value: 0.03, source: "declaration" },
    lanes: { value: 2, source: "declaration" },
    workingLanes: { value: 2, source: "default" },
  });
  const reply = await reloadedQueues({ lanes: 3, workingLanes: 3, sources: { lanes: "queues setting", workingLanes: "queues setting" } }, "restart-a:lanes-b");
  assert.deepEqual([reply.status, reply.reloadedFields, reply.restartFields], ["reloaded", ["queues"], []]);
  await until(async () => (await runs()).length === 3);
  const queue = await queueOf();
  assert.equal(queue.lanes, 3);
  assert.deepEqual([queue.settings.lanes, queue.settings.workingLanes], [{ value: 3, source: "queues setting" }, { value: 3, source: "queues setting" }]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-359 a reload lists queues in the restart fields when only the state or the interval changed", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuesPrelude}
const daemon = await launched({ ...started, queueMilliseconds: 60000 });
try {
  const limits = { lanes: 2, workingLanes: 2, sources: { lanes: "declaration", workingLanes: "default" } };
  for (let round = 0; round < 2; round += 1) {
    const reply = await reloadedQueues(limits, "restart-b:lanes-a");
    assert.deepEqual([reply.reloadedFields, reply.restartFields], [[], ["queues"]]);
  }
  assert.deepEqual((await queueOf()).settings.everySeconds, { value: 60, source: "declaration" });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-359 a mixed queues reload applies limits once and keeps the interval pending a restart", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuesPrelude}
const daemon = await launched({ ...started, queueMilliseconds: 60000 });
try {
  const limits = { lanes: 3, workingLanes: 1, sources: { lanes: "queues setting", workingLanes: "queues setting" } };
  const reply = await reloadedQueues(limits, "restart-b:lanes-b");
  assert.deepEqual([reply.reloadedFields, reply.restartFields], [["queues"], ["queues"]]);
  assert.deepEqual((await queueOf()).settings, {
    everySeconds: { value: 60, source: "declaration" },
    lanes: { value: 3, source: "queues setting" },
    workingLanes: { value: 1, source: "queues setting" },
  });
  const repeated = await reloadedQueues(limits, "restart-b:lanes-b");
  assert.deepEqual([repeated.reloadedFields, repeated.restartFields], [[], ["queues"]]);
  const reverted = await reloadedQueues(limits, "restart-a:lanes-b");
  assert.deepEqual([reverted.reloadedFields, reverted.restartFields], [[], []]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-361 each queue status exposes the next scheduled check", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${limitsPrelude}
const before = Date.now();
const daemon = await launched({ queueMilliseconds: 60000 });
try {
  const queue = await queueOf();
  assert.equal(typeof queue.nextCheckAt, "string");
  const next = Date.parse(queue.nextCheckAt);
  assert.ok(next >= before + 60000 && next <= Date.now() + 60000, JSON.stringify(queue));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

const laneReloadPrelude = `${limitsPrelude}
const { privateSettingsPath } = await import(${JSON.stringify(new URL("../src/cli/project-settings.ts", import.meta.url).href)});
process.env.XDG_CONFIG_HOME = directory + "/private-settings";
process.env.CLOVING_QUEUE_LANES = "2";
const file = privateSettingsPath(process.env, directory);
const idleHost = async () => ({ loadAverage: 0, cores: 1, memoryPressure: "normal" });
writeFileSync("reload.json", JSON.stringify({ bundleDigest, manifests: settings.manifests, declarations: settings.declarations, workflowRefusals: [], turnSettings: { profiles: {}, fallbackModels: [], tokenPrices: {} }, settingDigests: {} }));
writeFileSync("reload.mjs", \`import { readFileSync } from "node:fs";
import { projectConfiguration } from ${JSON.stringify(new URL("../tools/project-configuration.ts", import.meta.url).href)};
import { reloadedQueueLimits, queueWorkflowLimits } from ${JSON.stringify(new URL("../tools/self-host-queue.ts", import.meta.url).href)};
const base = JSON.parse(readFileSync(process.argv[2], "utf8"));
const config = await projectConfiguration(process.cwd(), process.env);
const given = { declarations: base.declarations, sources: config.sources };
process.stdout.write(JSON.stringify({ ...base, queueLimits: reloadedQueueLimits(config.environment, given), queueWorkflowLimits: queueWorkflowLimits(config.environment, given) }));\`);
`;

await test("CLV-377 queue-lanes writes only private lane settings, reloads automatically and refuses a stale count", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${laneReloadPrelude}
const { mkdirSync, statSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync(dirname(file), { recursive: true });
const original = { version: 1, queues: { develop: { everySeconds: 120 }, other: { lanes: 4 } } };
writeFileSync(file, JSON.stringify(original));
const daemon = await launched({ queueLanes: 2, reloadCommand, loadBundle, hostSignals: idleHost });
try {
  await until(async () => (await runs()).length === 2);
  const request = { workflowId: "develop", lanes: 3, expectedLanes: 2, commandId: "more-lanes" };
  const changed = await asked("queue-lanes", request);
  assert.equal(changed.kind, "queue-lanes", JSON.stringify(changed));
  assert.equal(changed.queue.lanes, 3);
  assert.deepEqual(changed.queue.settings.lanes, { value: 3, source: "queues setting (private file)" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...original, queues: { ...original.queues, develop: { everySeconds: 120, lanes: 3 } } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await asked("queue-lanes", request)).replayed, true);
  assert.equal((await asked("queue-lanes", { ...request, lanes: 4 })).code, "conflicting-command");
  assert.equal((await asked("queue-lanes", { ...request, commandId: "stale" })).code, "queue-lanes-changed");
  await until(async () => (await runs()).length === 3);
  const activeIds = (await runs()).map(run => run.runId).sort();
  const reduced = await asked("queue-lanes", { workflowId: "develop", lanes: 1, expectedLanes: 3, commandId: "fewer-lanes" });
  assert.equal(reduced.queue.lanes, 1);
  assert.deepEqual((await runs()).map(run => run.runId).sort(), activeIds);
  assert.equal((await runs()).some(run => ["cancelled", "failed", "completed"].includes(run.state)), false);
  writeFileSync("outcome-900", "handoff_requested");
  await until(async () => (await runs()).filter(run => run.state === "completed").length === 1);
  await delay(150);
  assert.equal((await runs()).length, 3);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-377 a lane reduction saves and reloads the valid total and working pair", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${laneReloadPrelude}
process.env.CLOVING_QUEUE_WORKING_LANES = "2";
const daemon = await launched({ reloadCommand, loadBundle, hostSignals: idleHost, settingSources: { "queue.workingLanes": "environment" }, queueMilliseconds: 60000, queueLanes: 3, queueLimits: { lanes: 3, workingLanes: 2, sources: { lanes: "environment", workingLanes: "environment" } } });
try {
  const reply = await asked("queue-lanes", { workflowId: "develop", lanes: 1, expectedLanes: 3, commandId: "below-working" });
  assert.equal(reply.kind, "queue-lanes", JSON.stringify(reply));
  assert.equal((await queueOf()).lanes, 1);
  assert.equal(reply.queue.settings.workingLanes.value, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).queues.develop, { lanes: 1, workingLanes: 1 });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
