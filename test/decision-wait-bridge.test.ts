import assert from "node:assert/strict";
import { test } from "node:test";
import { registerStepBridge } from "../src/host/step-bridge-host.ts";
import { waitForDecision } from "../src/steps/wait-for-decision.ts";
import type { DecisionResult, GateRequest } from "../src/step-bridge.ts";

const request: GateRequest = {
  gateId: "review",
  kind: "approval",
  prompt: "Approve?",
};

await test("CLV-219 a fake step bridge returns the same-call decision for workflow tests", async () => {
  const requests: GateRequest[] = [];
  const result: DecisionResult = { decision: "approved", answer: null };
  const remove = registerStepBridge({
    effect: () => Promise.resolve({ kind: "unavailable", reason: "unused" }),
    gate: () => Promise.resolve({ kind: "unavailable", reason: "unused" }),
    waitForDecision: (given) => {
      requests.push(given);
      return Promise.resolve(result);
    },
  });
  try {
    assert.deepEqual(await waitForDecision(request), result);
    assert.deepEqual(requests, [request]);
  } finally {
    remove();
  }
  await assert.rejects(waitForDecision(request), /cloving-host-unavailable/);
});
