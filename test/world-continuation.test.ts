import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { decisionPrelude, decisionWorkflow } from "./decision-wait-fixture.ts";
import { field, waitingGate, withHarness } from "./service-fixture.ts";

await test("CLV-265 with host bound 1, another run starts while the first waits for a decision", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  assert.equal(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY, "1");
  const first = await submitted("first");
  await pendingGate(first);
  const second = await submitted("second");
  await pendingGate(second);
  await hookReady(first);
  await hookReady(second);
  assert.equal((await tagged()).length, 2);
  await decide(first);
  await verified(first);
  await decide(second);
  await verified(second);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-265 status reads a stored legacy decisionGate wait after restart", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const { runId } = await waitingGate(harness, {
      service: first,
      commandId: "legacy-gate",
      kind: "question",
    });
    await first.close();
    const second = await harness.start();
    try {
      const json = await harness.cli(["status", runId, "--json"]);
      assert.equal(json.status, 0, json.stderr);
      const stored: unknown = JSON.parse(json.stdout);
      const run = field(stored, "run");
      assert.equal(field(run, "state"), "waiting_gate");
      assert.deepEqual(field(run, "pendingDecisions"), [`${runId}/design-1`]);
      const text = await harness.cli(["status", runId]);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /design-1/);
    } finally {
      await second.close();
    }
  }));
