import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { withFiles } from "./quality/files-fixture.ts";
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

await test("CLV-219 public fake scenarios queue same-call decisions without consuming the effect budget", () => {
  const helpers = pathToFileURL(resolve("src/workflows.ts")).href;
  const request = { gateId: "review", kind: "approval", prompt: "Approve?" };
  const decisions = [
    { decision: "approved", answer: null },
    { decision: "answered", answer: "Keep the parser." },
  ] as const;
  return withFiles(
    {
      "decisions.mjs": `import { waitForDecision } from ${JSON.stringify(helpers)};
export async function sample() {
  const request = ${JSON.stringify(request)};
  return [await waitForDecision(request), await waitForDecision(request)];
}`,
    },
    async (root) => {
      const scenario = {
        workflow: join(root, "decisions.mjs"),
        exportName: "sample",
        input: null,
        decisions,
        effectLimit: 0,
      };
      const result = await runScenario(scenario);
      assert.deepEqual(result, {
        outcome: decisions,
        requests: [
          ["waitForDecision", request],
          ["waitForDecision", request],
        ],
        spent: 0,
      });
      assert.deepEqual(decisions, [
        { decision: "approved", answer: null },
        { decision: "answered", answer: "Keep the parser." },
      ]);
    },
  );
});

await test("CLV-219 public fake bridges report a missing decision result", async () => {
  using bridge = fakeStepBridge({});
  await assert.rejects(waitForDecision(request), /no-scenario-result/);
  assert.deepEqual(bridge.requests, [["waitForDecision", request]]);
});
