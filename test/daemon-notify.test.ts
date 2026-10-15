import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyPrelude, notifyWorkflow } from "./daemon-notify-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-090 failed notifier initialization releases the daemon so startup can be retried", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const result = await consumer.run(`${notifyPrelude}
writeFileSync("notify-events.json", "{}");
await assert.rejects(startDaemon(settings), /invalid-notify-record/);
rmSync("notify-events.json");
const daemon = await launched();
try {
  await submitNotice("recovered", { kind: "blocked" });
  await until(() => notices().length === 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-090 the daemon notifies one approval with operator commands and run identity", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const result = await consumer.run(`${notifyPrelude}
const daemon = await launched();
try {
  const runId = await submitNotice("approval");
  await until(async () => (await asked("questions", { runId })).decisions.length === 1);
  await until(() => notices().length === 1);
  const [notice] = notices();
  const [decision] = (await asked("questions", { runId })).decisions;
  assert.equal(notice.event, "decision");
  assert.equal(notice.runId, runId);
  assert.equal(notice.workflowId, "develop-ticket");
  assert.equal(notice.subject, "Cloving: develop-ticket waits for your decision");
  assert.ok(notice.body.includes("approval"));
  assert.ok(notice.body.includes(decision.prompt));
  const binding = "--expected-revision " + decision.revision + " --generation " + decision.generation + " --subject-digest " + decision.subjectDigest;
  assert.ok(notice.body.includes("cloving approve " + (decision.label ?? decision.decisionId) + " " + binding));
  assert.ok(notice.body.includes('cloving deny ' + (decision.label ?? decision.decisionId) + ' --text "<feedback>" ' + binding));
  await delay(150);
  assert.equal(notices().length, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-090 blocked and failed runs notify once while a successful handoff stays quiet", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const result = await consumer.run(`${notifyPrelude}
const daemon = await launched();
try {
  for (const kind of ["blocked", "failed", "handoff_requested"])
    await submitNotice(kind, { kind });
  await until(() => notices().length === 2);
  const byEvent = Object.fromEntries(notices().map((notice) => [notice.event, notice]));
  assert.ok(byEvent.blocked.body.includes("fixture outcome reason"));
  const failed = await shown(runIdentity("failed"));
  assert.ok(byEvent.failed.body.includes(failed.reason.detail));
  for (const kind of ["blocked", "failed"]) {
    assert.equal(byEvent[kind].runId, runIdentity(kind));
    assert.ok(byEvent[kind].body.includes("cloving status " + runIdentity(kind)));
  }
  await delay(150);
  assert.equal(notices().length, 2);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-090 the first notification start baselines existing runs and a disabled daemon does nothing", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const first = await consumer.run(`${notifyPrelude}
const daemon = await launched({ notifyCommand: undefined });
try {
  const runId = await submitNotice("old", { kind: "blocked" });
  await until(async () => (await shown(runId)).state === "completed");
  await delay(150);
  assert.deepEqual(notices(), []);
  assert.equal(existsSync("notify-events.json"), false);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(first.status, 0, first.stderr);
    const second = await consumer.run(`${notifyPrelude}
const daemon = await launched();
try {
  await delay(150);
  assert.deepEqual(notices(), []);
  await submitNotice("fresh", { kind: "blocked" });
  await until(() => notices().length === 1);
  assert.equal(notices()[0].runId, runIdentity("fresh"));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
  }));

await test("CLV-090 long decision prompts keep complete commands in a body of at most 4000 characters", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const result = await consumer.run(`${notifyPrelude}
const daemon = await launched();
try {
  const runId = await submitNotice("long", { kind: "approval", prompt: "x".repeat(4000) });
  await until(() => notices().length === 1);
  const [decision] = (await asked("questions", { runId })).decisions;
  const body = notices()[0].body;
  assert.ok(body.length <= 4000);
  assert.ok(body.includes("xxx"));
  const binding = "--expected-revision " + decision.revision + " --generation " + decision.generation + " --subject-digest " + decision.subjectDigest;
  assert.ok(body.includes("cloving approve " + (decision.label ?? decision.decisionId) + " " + binding));
  assert.ok(body.includes('cloving deny ' + (decision.label ?? decision.decisionId) + ' --text "<feedback>" ' + binding));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-090 a notify command failure is one error line and never retried", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const result = await consumer.run(`${notifyPrelude}
appendFileSync("notify.mjs", "process.exitCode = 1;");
const daemon = await launched();
try {
  await submitNotice("bad-command", { kind: "blocked" });
  await until(() => notices().length === 1);
  await delay(200);
  assert.equal(notices().length, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    const errors = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("Notify command failed:"));
    assert.equal(errors.length, 1, result.stderr);
    assert.match(String(errors[0]), /code 1/);
  }));

await test("CLV-090 notified decisions and blocked outcomes stay quiet after daemon restart", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const first = await consumer.run(`${notifyPrelude}
const daemon = await launched();
try {
  await submitNotice("review");
  await submitNotice("blocked", { kind: "blocked" });
  await until(() => notices().length === 2);
  assert.deepEqual(notices().map((notice) => notice.event).sort(), ["blocked", "decision"]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(first.status, 0, first.stderr);
    const second = await consumer.run(`${notifyPrelude}
const daemon = await launched();
try {
  await delay(250);
  assert.equal(notices().length, 2);
  await submitNotice("new", { kind: "blocked" });
  await until(() => notices().length === 3);
  assert.equal(notices()[2].runId, runIdentity("new"));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
  }));
