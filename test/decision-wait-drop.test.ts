import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { decisionPrelude, decisionWorkflow } from "./decision-wait-fixture.ts";

const sequential = decisionWorkflow.replace(
  "  await recordDecision(decision);",
  `
  await waitForDecision({ gateId: "second-review", kind: "approval", prompt: "Approve again?" });
  await recordDecision(decision);`,
);

await test("CLV-219 dropping a later wait confirms the stop of earlier hook deliveries", () =>
  withConsumer(sequential, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = await submitted("two-waits");
  await pendingGate(runId);
  await decide(runId);
  await until(async () => (await asked("questions", { runId })).decisions.some((gate) => gate.gateId === "second-review"));
  await asked("run-command", { command: "drop", runId, expectedRevision: (await asked("status", { runId })).run.revision, commandId: "drop-later" });
  await until(async () => (await getRun(await sdkRun(runId)).status) === "cancelled");
  await until(async () => (await asked("status", { runId })).run.reason.code === "run-cancelled");
  assert.deepEqual(decisions(), []);
  assert.equal((await eventTypes(runId)).filter((event) => event === "gate.decided").length, 1);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));
