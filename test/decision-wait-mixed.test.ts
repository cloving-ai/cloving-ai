import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import {
  decisionPrelude,
  mixedDecisionWorkflow,
} from "./decision-wait-fixture.ts";

await test("CLV-219 waitForDecision resumes the invocation after a legacy decisionGate", () =>
  withConsumer(mixedDecisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = await submitted("mixed");
  assert.equal((await pendingGate(runId)).gateId, "legacy");
  await decide(runId, "approve", { commandId: "legacy-approve" });
  await until(async () => (await asked("questions", { runId })).decisions.some((gate) => gate.gateId === "review-1"));
  await decide(runId, "approve", { commandId: "hook-approve" });
  await until(async () => (await stateOf(runId)) === "completed");
  const calls = await segments();
  assert.deepEqual(calls.map((call) => call.kind), ["start-run", "continue-run"]);
  assert.deepEqual(calls[1].output.decision, { decision: "approved", answer: null });
  assert.deepEqual(decisions(), [{ decision: "approved", answer: null }]);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));
