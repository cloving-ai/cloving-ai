import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { decisionPrelude, decisionWorkflow } from "./decision-wait-fixture.ts";

await test("CLV-219 Local World returns approval to the original workflow call", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = await submitted("approval");
  const pending = await pendingGate(runId);
  assert.deepEqual(pending.allowed, ["approve", "deny"]);
  const reply = await decide(runId);
  assert.equal(reply.kind, "decision-recorded");
  await verified(runId);
  assert.deepEqual(decisions(), [{ decision: "approved", answer: null }]);
  print({ completed: true });
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [{ completed: true }]);
  }));

await test("CLV-219 stale decision bindings leave the hook waiting", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = await submitted("stale");
  const gate = await pendingGate(runId);
  await hookReady(runId);
  for (const [index, stale] of [{ expectedRevision: 0 }, { expectedRevision: gate.revision + 1 }, { generation: gate.generation + 1 }, { subjectDigest: "sha256:" + "0".repeat(64) }].entries()) {
    const reply = await decide(runId, "approve", { ...stale, commandId: "stale-" + index });
    assert.notEqual(reply.kind, "decision-recorded");
    assert.equal(await stateOf(runId), "waiting_gate");
    assert.equal((await sdkEvents(runId)).filter((event) => event.eventType === "hook_received").length, 0);
    assert.deepEqual(decisions(), []);
  }
  assert.equal((await decide(runId)).kind, "decision-recorded");
  await verified(runId);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-219 two runs share a gate ID and receive separate decisions", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const first = await submitted("first");
  const second = await submitted("second");
  await pendingGate(first);
  await pendingGate(second);
  assert.equal((await asked("questions", {})).decisions.length, 2);
  await decide(second, "deny");
  await verified(second, { decision: "denied", answer: null });
  assert.equal(await stateOf(first), "waiting_gate");
  await decide(first);
  await verified(first);
  assert.deepEqual(decisions(), [{ decision: "denied", answer: null }, { decision: "approved", answer: null }]);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-219 question answers return the stored text in the same call", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
writeFileSync("gate-settings", JSON.stringify({ kind: "question" }));
const service = await hosted();
try {
  const runId = await submitted("answer");
  const pending = await pendingGate(runId);
  assert.deepEqual(pending.allowed, ["answer"]);
  await decide(runId, "answer", { text: "Keep the table parser." });
  await verified(runId, { decision: "answered", answer: "Keep the table parser." });
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-219 drop cancels the SDK wait without creating a decision", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = await submitted("start-drop");
  await pendingGate(runId);
  await hookReady(runId);
  await asked("run-command", { command: "drop", runId, expectedRevision: (await asked("status", { runId })).run.revision, commandId: "drop" });
  await until(async () => (await getRun(await sdkRun(runId)).status) === "cancelled");
  assert.equal(await stateOf(runId), "cancelled");
  assert.deepEqual((await asked("questions", { runId })).decisions, []);
  assert.equal(Object.values((await ports.state()).gates)[0].outcome?.decision, null);
  assert.equal((await eventTypes(runId)).includes("gate.decided"), false);
  assert.deepEqual(decisions(), []);
  assert.equal((await sdkEvents(runId)).filter((event) => event.eventType === "hook_received").length, 0);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));
