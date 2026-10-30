import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAuthority, type RunState } from "../src/authority/reducer.ts";
import type { OperationView } from "../src/broker/actor/authority.ts";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import { recoverClaude } from "../src/daemon/daemon-adapters.ts";

const operation: OperationView = {
  operationId: "operation-1",
  runId: "run-1",
  capability: "claude",
  method: "run-turn",
  target: "target-1",
  payload: "payload-1",
  inputDigest: "input-1",
  units: 1,
  leaseKey: "target-1",
  recoveryLimit: 3,
  status: "running",
  reason: null,
  attempts: 0,
  receipt: "receipt-1",
  worker: "claude",
  result: null,
  requestedSequence: 1,
  waitSequence: null,
  settledSequence: null,
  leaseGeneration: 1,
  waitCause: null,
};

function recovery() {
  const run: RunState = {
    runId: "run-1",
    status: "running",
    revision: 1,
    workflow: "workflow-1",
    pausedFrom: null,
    gates: [],
  };
  const current = { run, operation, harness: "claude" };
  const calls: DeliveryIntent[] = [];
  return {
    current,
    calls,
    worker: {
      harness: () => Promise.resolve(current.harness),
      recover: (intent: DeliveryIntent) => {
        calls.push(intent);
        return Promise.resolve();
      },
    },
    ports: {
      state: () =>
        Promise.resolve({
          ...emptyAuthority,
          runs: { "run-1": current.run },
        }),
      operations: () => Promise.resolve([current.operation]),
    },
  };
}

await test("CLV-239 startup recovers the current authority intent through the worker", async () => {
  const scene = recovery();
  await recoverClaude(scene.worker, scene.ports);
  assert.deepEqual(scene.calls, [
    {
      ...operation,
      kind: "protected-effect",
      purpose: "reconcile",
      workflow: "workflow-1",
    },
  ]);
});

for (const status of [
  "queued",
  "paused",
  "waiting_gate",
  "cancelled",
  "completed",
  "failed",
] as const)
  await test(`CLV-239 startup never resumes a ${status} run`, async () => {
    const scene = recovery();
    scene.current.run = { ...scene.current.run, status };
    await recoverClaude(scene.worker, scene.ports);
    assert.deepEqual(scene.calls, []);
  });

for (const harness of [
  "codex",
  "gemini",
  "opencode",
  "grok",
  "cursor",
  "shell",
])
  await test(`CLV-239 startup leaves the ${harness} harness unchanged`, async () => {
    const scene = recovery();
    scene.current.harness = harness;
    await recoverClaude(scene.worker, scene.ports);
    assert.deepEqual(scene.calls, []);
  });

await test("CLV-239 startup revalidates cancellation after reading the harness", async () => {
  const scene = recovery();
  scene.worker.harness = () => {
    scene.current.run = { ...scene.current.run, status: "cancelled" };
    return Promise.resolve("claude");
  };
  await recoverClaude(scene.worker, scene.ports);
  assert.deepEqual(scene.calls, []);
});

await test("CLV-239 startup cannot resume a superseded lease", async () => {
  const scene = recovery();
  scene.worker.harness = () => {
    scene.current.operation = {
      ...scene.current.operation,
      leaseGeneration: 2,
    };
    return Promise.resolve("claude");
  };
  await recoverClaude(scene.worker, scene.ports);
  assert.deepEqual(scene.calls, []);
});
