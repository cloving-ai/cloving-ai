import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import {
  protectedEffect,
  decisionGate,
  handoff,
  waitForRun,
} from "../src/workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";

const effectModule = pathToFileURL(
  resolve("src/steps/protected-effect.ts"),
).href;
const source = `import { protectedEffect } from ${JSON.stringify(effectModule)};
export async function sample(input) {
  return await protectedEffect({
    scope: { phase: "work", operation: "turn", round: 1 },
    capability: "claude", method: "run-turn", target: "sample", payload: input, units: 1,
  });
}`;
const completed = {
  kind: "completed",
  operationId: "turn",
  receipt: null,
  result: "scenario-result",
} as const;

await test("CLV-224 a portable scenario captures requests and returns fake step results", () =>
  withFiles({ "sample.mjs": source }, async (root) => {
    const result = await runScenario({
      workflow: pathToFileURL(join(root, "sample.mjs")).href,
      exportName: "sample",
      input: "test-payload",
      turn: completed,
    });
    assert.deepEqual(result.outcome, completed);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(result.requests[0]?.[0], "effect");
  }));

await test("CLV-224 fake bridges restore prior descriptors and refuse an active host", async () => {
  const key = Symbol.for("cloving.step-bridge/v1");
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: undefined,
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  try {
    {
      using bridge = fakeStepBridge({});
      assert.throws(() => fakeStepBridge({}), {
        message: "workflow-testing-host-active",
      });
      assert.deepEqual(
        await decisionGate({
          gateId: "gate",
          kind: "question",
          prompt: "test",
        }),
        { kind: "unavailable", reason: "no-scenario-result" },
      );
      assert.equal(
        await handoff({ workflowId: "other", input: {} }),
        "target-run",
      );
      assert.deepEqual(
        await waitForRun({ runId: "target-run", maximumWaitSeconds: 1 }),
        {
          kind: "unavailable",
          reason: "no-scenario-result",
          promotionId: null,
        },
      );
      assert.equal(bridge.requests.length, 3);
    }
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis, key),
      previous,
    );
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});

await test("CLV-224 fake effect queues do not mutate scenario data and report missing results", async () => {
  const effects = { "claude run-turn": [completed] };
  using bridge = fakeStepBridge({ effects });
  const request = {
    scope: { phase: "work", operation: "turn", round: 1 },
    capability: "claude",
    method: "run-turn",
    target: "test",
    payload: "test",
    units: 1,
  };
  assert.deepEqual(await protectedEffect(request), completed);
  assert.deepEqual(await protectedEffect(request), {
    kind: "unavailable",
    reason: "no-scenario-result",
  });
  assert.deepEqual(effects, { "claude run-turn": [completed] });
  assert.equal(bridge.spent, 0);
});

await test("CLV-224 scenario runners accept filesystem paths and reject absent results", () =>
  withFiles(
    { "empty.mjs": "export async function empty() {}" },
    async (root) => {
      await assert.rejects(
        runScenario({
          workflow: join(root, "empty.mjs"),
          exportName: "empty",
          input: null,
        }),
        { message: "invalid-workflow-scenario-result" },
      );
    },
  ));

await test("CLV-224 scenarios consume effect queues and apply the declared fake budget", () =>
  withFiles({ "sample.mjs": source }, async (root) => {
    const workflow = pathToFileURL(join(root, "sample.mjs")).href;
    const first = await runScenario({
      workflow,
      exportName: "sample",
      input: null,
      effects: { "claude run-turn": [completed] },
      effectLimit: 1,
    });
    assert.deepEqual(first.outcome, completed);
    assert.equal(first.spent, 1);
    const refused = await runScenario({
      workflow,
      exportName: "sample",
      input: null,
      turn: completed,
      effectLimit: 0,
    });
    assert.deepEqual(refused.outcome, {
      kind: "refused",
      reason: "budget-exhausted",
    });
    const missing = await runScenario({
      workflow,
      exportName: "sample",
      input: null,
      effects: {},
    });
    assert.deepEqual(missing.outcome, {
      kind: "unavailable",
      reason: "no-scenario-result",
    });
  }));

await test("CLV-224 scenarios support decisions, gates, handoffs and run waits", () => {
  const helpers = pathToFileURL(resolve("src/workflows.ts")).href;
  return withFiles(
    {
      "steps.mjs": `import { decisionGate, handoff, waitForRun } from ${JSON.stringify(helpers)};
export async function sample(input, decision) {
  const gate = await decisionGate({ gateId: input, kind: "approval", prompt: "review" });
  const run = await handoff({ workflowId: "other", input: {} });
  return { gate, run, waited: await waitForRun({ runId: run, maximumWaitSeconds: 10 }), decision };
}`,
    },
    async (root) => {
      const result = await runScenario({
        workflow: pathToFileURL(join(root, "steps.mjs")).href,
        exportName: "sample",
        input: "gate",
        decision: "approved",
        gate: { kind: "opened", decisionId: "decision" },
        effects: { handoff: [{ ...completed, result: "run" }] },
        waits: [{ kind: "completed", reason: null, promotionId: null }],
      });
      assert.deepEqual(result.outcome, {
        gate: { kind: "opened", decisionId: "decision" },
        run: "run",
        waited: { kind: "completed", reason: null, promotionId: null },
        decision: "approved",
      });
      assert.deepEqual(
        result.requests.map(([kind]) => kind),
        ["gate", "handoff", "waitForRun"],
      );
    },
  );
});

await test("CLV-224 overlapping scenarios isolate their bridges and always restore the host", () =>
  withFiles({ "sample.mjs": source }, async (root) => {
    const workflow = pathToFileURL(join(root, "sample.mjs")).href;
    const results = await Promise.all(
      ["first", "second"].map((result) =>
        runScenario({
          workflow,
          exportName: "sample",
          input: result,
          turn: { ...completed, result },
        }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.outcome),
      [
        { ...completed, result: "first" },
        { ...completed, result: "second" },
      ],
    );
    await assert.rejects(
      runScenario({ workflow, exportName: "missing", input: null }),
      /workflow-test-export-missing/,
    );
    assert.equal(
      Reflect.get(globalThis, Symbol.for("cloving.step-bridge/v1")),
      undefined,
    );
  }));
