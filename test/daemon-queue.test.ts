import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-084 the daemon queue admits the next ready issue with the ticket command input", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  const run = await until(async () => (await runs())[0]);
  assert.equal(run.workflowId, "develop-issue");
  await until(() => existsSync("input-CLV-900"));
  const input = JSON.parse(readFileSync("input-CLV-900", "utf8"));
  assert.equal(input.ticketId, "CLV-900");
  assert.equal(input.ticket, "# CLV-900: Queue task");
  assert.equal(input.delivery, "pull-request");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-084 a successful queue run retires its command and starts the next ready issue", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(() => existsSync("input-CLV-900"));
  const [previous] = commands();
  writeFileSync("ready", "CLV-901");
  writeFileSync("outcome-CLV-900", "handoff_requested");
  await until(() => existsSync("input-CLV-901"));
  assert.equal((await runs()).length, 2);
  assert.equal(commands().length, 1);
  assert.equal(commands().includes(previous), false);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stderr.includes("Queue stopped:"),
      false,
      result.stderr,
    );
  }));

await test("CLV-084 active issue runs hold the queue until handoff and other workflows do not hold it", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const daemon = await launched({ queueMilliseconds: 100 });
try {
  const manual = await submitted("manual");
  const other = await submitted("other", { workflowId: "develop-ticket", submission: { ticket: "CLV-902" } });
  writeFileSync("ready", "CLV-901");
  await until(() => existsSync("input-CLV-900"));
  await delay(350);
  assert.equal((await runs()).length, 2);
  assert.equal(existsSync("checks"), false);
  writeFileSync("outcome-CLV-900", "handoff_requested");
  await until(async () => (await runs()).length === 3);
  assert.equal((await shown(manual.runId)).outcome.kind, "handoff_requested");
  assert.notEqual((await shown(other.runId)).state, "completed");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-084 empty next results keep polling silently and retire each persisted command", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("next.mjs", 'import { appendFileSync, readFileSync } from "node:fs"; const ids = JSON.parse(readFileSync("queue-commands.json", "utf8")); if (ids.length !== 1) process.exit(2); appendFileSync("checks", ids[0] + "\\\\n");');
const daemon = await launched();
try {
  await until(() => existsSync("checks") && readFileSync("checks", "utf8").trim().split("\\n").length >= 3);
  assert.equal((await runs()).length, 0);
} finally { await daemon.close(); }
assert.deepEqual(commands(), []);
const checked = readFileSync("checks", "utf8").trim().split("\\n");
assert.equal(new Set(checked).size, checked.length);
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stderr.includes("Queue stopped:"),
      false,
      result.stderr,
    );
  }));

await test("CLV-084 a refusal stops the queue and retains the command that may be admitted later", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("ready", "not a ticket");
const daemon = await launched();
try {
  await until(() => existsSync("checks"));
  await delay(250);
  assert.equal(readFileSync("checks", "utf8").trim().split("\\n").length, 1);
  assert.equal(commands().length, 1);
  assert.equal((await runs()).length, 0);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Queue stopped:.*invalid-ticket-id/);
    assert.equal(result.stderr.split("Queue stopped:").length, 2);
  }));

await test("CLV-084 no queue setting leaves the daemon idle", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const daemon = await launched({ queueMilliseconds: undefined });
try {
  await delay(250);
  assert.deepEqual(await runs(), []);
  assert.equal(existsSync("checks"), false);
  assert.equal(existsSync("queue-commands.json"), false);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-084 a blocked queue run stops further admissions and reports its identity and outcome once", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  const run = await until(async () => (await runs())[0]);
  writeFileSync("ready", "CLV-901");
  writeFileSync("outcome-CLV-900", "blocked");
  await until(async () => (await shown(run.runId)).state === "completed");
  await delay(250);
  assert.equal((await runs()).length, 1);
  print({ runId: run.runId });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    const [run] = result.lines;
    assert.ok(run && typeof run === "object" && "runId" in run);
    const lines = result.stderr
      .split("\n")
      .filter((line) => line.includes("Queue stopped:"));
    assert.equal(lines.length, 1, result.stderr);
    assert.match(
      String(lines[0]),
      new RegExp(`${String(run.runId)}.*completed.*blocked`),
    );
  }));
