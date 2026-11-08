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
