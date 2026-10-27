import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  fakeStepBridge,
  runScenario,
  type ScenarioRequest,
  type ScenarioResult,
} from "../src/testing.ts";
import {
  decisionGate,
  handoff,
  protectedEffect,
  waitForRun,
} from "../src/workflows.ts";
import { withFiles } from "./quality/files-fixture.ts";

const requests = [
  [
    "effect",
    {
      scope: {
        phase: "work",
        operation: "turn",
        round: 1,
        key: "key",
        stage: { id: "stage", visit: "visit", branch: "main" },
      },
      capability: "claude",
      method: "run-turn",
      target: "sample",
      payload: "",
      units: 1,
      resource: "worker",
    },
  ],
  [
    "gate",
    { gateId: "gate", kind: "approval", prompt: "review", expiresAt: "later" },
  ],
  [
    "handoff",
    {
      workflowId: "other",
      input: { nested: [true, 1, null, { key: "value" }] },
    },
  ],
  ["waitForRun", { runId: "target-run", maximumWaitSeconds: 1 }],
] as const;

function requestDetails([kind, request]: ScenarioRequest) {
  switch (kind) {
    case "effect":
      return [request.capability, request.scope.stage?.visit, request.resource];
    case "gate":
    case "waitForDecision":
      return request.expiresAt;
    case "handoff":
      return request.input;
    case "waitForRun":
      return request.maximumWaitSeconds;
  }
}

function inspectRequests(requests: ScenarioResult["requests"]): void {
  assert.deepEqual(requests.map(requestDetails), [
    ["claude", "visit", "worker"],
    "later",
    { nested: [true, 1, null, { key: "value" }] },
    1,
  ]);
}

await test("CLV-224 recorded requests narrow to each concrete step request type", async () => {
  using bridge = fakeStepBridge({});
  await protectedEffect(requests[0][1]);
  await decisionGate(requests[1][1]);
  await handoff(requests[2][1]);
  await waitForRun(requests[3][1]);
  inspectRequests(bridge.requests);
  await withFiles(
    {
      "requests.mjs": `export async function sample(input) {
  const bridge = Reflect.get(globalThis, Symbol.for("cloving.step-bridge/v1"));
  for (const [kind, request] of input) await bridge[kind](request);
  return null;
}`,
    },
    async (root) => {
      const result = await runScenario({
        workflow: join(root, "requests.mjs"),
        exportName: "sample",
        input: requests,
      });
      inspectRequests(result.requests);
    },
  );
});

await test("CLV-224 scenarios reject malformed recorded request payloads", () =>
  withFiles(
    {
      "malformed.mjs": `export async function sample(input) {
  const bridge = Reflect.get(globalThis, Symbol.for("cloving.step-bridge/v1"));
  await bridge[input.kind](input.request);
  return null;
}`,
    },
    async (root) => {
      const workflow = join(root, "malformed.mjs");
      for (const [kind, request] of [
        ["effect", null],
        ["effect", {}],
        [
          "effect",
          {
            scope: { phase: "work", operation: "turn", round: "one" },
            capability: "claude",
            method: "turn",
            target: "target",
            payload: "",
            units: 1,
          },
        ],
        ["gate", null],
        ["gate", {}],
        ["gate", { gateId: "gate", kind: "other", prompt: "review" }],
        ["gate", { gateId: "gate", kind: ["approval"], prompt: "review" }],
        [
          "gate",
          { gateId: "gate", kind: "approval", prompt: "review", expiresAt: 1 },
        ],
        ["handoff", null],
        ["handoff", { workflowId: "other", input: [] }],
        ["handoff", { workflowId: 1, input: {} }],
        ["waitForRun", null],
        ["waitForRun", { runId: "run", maximumWaitSeconds: "one" }],
      ] as const) {
        await assert.rejects(
          runScenario({
            workflow,
            exportName: "sample",
            input: { kind, request },
          }),
          { message: "invalid-workflow-scenario-result" },
        );
      }
    },
  ));
