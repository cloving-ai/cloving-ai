import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
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

await test("CLV-219 the hook helper waits for its token and disposes on resolution or rejection", async () => {
  const helper = pathToFileURL(resolve("src/steps/wait-for-decision.ts")).href;
  const bridge = pathToFileURL(resolve("src/host/step-bridge-host.ts")).href;
  const script = `
import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
const log = [];
let result;
const sdk = await import("workflow");
mock.module("workflow", { namedExports: { ...sdk, createHook(options) {
  log.push(options);
  return { then: result.promise.then.bind(result.promise), [Symbol.dispose]() { log.push("disposed"); } };
} } });
const { waitForDecision } = await import(${JSON.stringify(helper)});
const { registerStepBridge } = await import(${JSON.stringify(bridge)});
const remove = registerStepBridge({
  effect: async () => ({ kind: "unavailable", reason: "unused" }),
  gate: async () => ({ kind: "unavailable", reason: "unused" }),
  waitForDecision: async (request) => { assert.deepEqual(request, ${JSON.stringify(request)}); return { token: "run/review" }; },
});
try {
  for (const rejected of [false, true]) {
    result = Promise.withResolvers();
    const waiting = waitForDecision(${JSON.stringify(request)});
    const expected = { decision: "approved", answer: null };
    let settled = false;
    const checked = waiting.then((value) => { settled = true; return value; }, (error) => { settled = true; throw error; });
    await setImmediate();
    assert.equal(settled, false);
    assert.deepEqual(log.splice(0), [{ token: "run/review" }]);
    if (rejected) {
      const failure = new Error("hook-failed");
      result.reject(failure);
      await assert.rejects(checked, (error) => error === failure);
    } else {
      result.resolve(expected);
      assert.deepEqual(await checked, expected);
    }
    assert.deepEqual(log.splice(0), ["disposed"]);
  }
} finally { remove(); mock.restoreAll(); }
`;
  const result = await promisify(execFile)(process.execPath, [
    "--experimental-test-module-mocks",
    "--input-type=module",
    "-e",
    script,
  ]);
  assert.equal(result.stdout, "");
});
