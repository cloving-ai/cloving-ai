import assert from "node:assert/strict";
import { test } from "node:test";
import { startDelivery } from "../src/host/start-delivery.ts";
import { withConsumer } from "./world-host-fixture.ts";
import {
  decisionPrelude,
  singleCallDecisionWorkflow,
} from "./decision-wait-fixture.ts";

await test("CLV-265 approval returns to the same workflow invocation with one input argument", () =>
  withConsumer(singleCallDecisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = await submitted("single-call");
  await decide(runId);
  const receipt = await verified(runId);
  const output = await getRun(receipt).returnValue;
  assert.equal(output.argumentCount, 1);
  assert.deepEqual((await segments()).map((call) => call.kind), ["start-run"]);
  assert.deepEqual(decisions(), [{ decision: "approved", answer: null }]);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-265 a legacy continuation cannot start a second workflow invocation", async () => {
  const lookups: string[] = [];
  const delivery = startDelivery({
    runs: () => Promise.resolve([]),
    input: () => Promise.resolve("{}"),
    document: () => Promise.resolve(undefined),
    workflow: (intent) => {
      lookups.push(intent.kind);
      return Promise.resolve(undefined);
    },
    cancel: () => Promise.resolve("cancelled"),
  });
  await assert.rejects(
    delivery.deliver({
      kind: "continue-run",
      runId: "old-run",
      operationId: "old-operation",
      workflow: "develop",
      gateId: "old-gate",
      decision: "approved",
      answer: null,
    }),
    { message: "unsupported-intent: continue-run" },
  );
  assert.deepEqual(lookups, []);
});
