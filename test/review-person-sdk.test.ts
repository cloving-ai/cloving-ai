import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { decisionPrelude } from "./decision-wait-fixture.ts";

const workflow = `import { reviewByPerson } from "cloving/workflows/steps/review-by-person";
export async function develop(input: { cycleId: string }) {
  "use workflow";
  const subject = { draft: "First draft", commit: "${"a".repeat(40)}" };
  const first = await reviewByPerson({ subject });
  const repeated = await reviewByPerson({ subject });
  const changed = await reviewByPerson({ subject: { draft: "Changed draft", commit: subject.commit } });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: changed.subjectDigest, first, repeated, changed };
}`;

await test("CLV-220 compiled person reviews retain approval only for the same draft", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = await submitted("review-draft");
  const firstGate = await pendingGate(runId);
  assert.deepEqual(firstGate.allowed, ["approve", "deny"]);
  await hookReady(runId);
  assert.equal(await stateOf(runId), "waiting_gate");
  assert.equal((await getRun(await sdkRun(runId)).status), "running");
  assert.equal((await decide(runId)).kind, "decision-recorded");
  await until(async () => (await asked("questions", { runId })).decisions.some((gate) => gate.decisionId !== firstGate.decisionId));
  const changedGate = await pendingGate(runId);
  assert.notEqual(changedGate.decisionId, firstGate.decisionId);
  assert.notEqual(changedGate.subjectDigest, firstGate.subjectDigest);
  assert.equal(await stateOf(runId), "waiting_gate");
  assert.equal((await decide(runId, "deny")).kind, "decision-recorded");
  await until(async () => (await stateOf(runId)) === "completed");
  const output = await getRun(await sdkRun(runId)).returnValue;
  assert.equal(output.first.accepted, true);
  assert.equal(output.first.commit, null);
  assert.deepEqual(output.repeated, output.first);
  assert.equal(output.changed.accepted, false);
  assert.equal(output.changed.commit, null);
  assert.notEqual(output.changed.subjectDigest, output.first.subjectDigest);
  const events = await sdkEvents(runId);
  assert.equal(events.filter((event) => event.eventType === "hook_created").length, 2);
  assert.equal(events.filter((event) => event.eventType === "hook_received").length, 2);
  assert.equal(lines("destination.log").length, 0);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));
