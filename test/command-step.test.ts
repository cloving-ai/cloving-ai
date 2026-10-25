import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/workflows.ts";
import { registerStepBridge } from "../src/host/step-bridge-host.ts";
import type { ProtectedRequest, ProtectedResult } from "../src/step-bridge.ts";

const request = {
  scope: { phase: "scan", operation: "reviews", round: 1 },
  name: "review-requests",
  input: { cursor: null, labels: ["ready"], options: { archived: false } },
};

await test("CLV-178 the command helper serializes input and awaits the protected command result", async () => {
  const requests: ProtectedRequest[] = [];
  const result: ProtectedResult = {
    kind: "completed",
    operationId: "operation-1",
    receipt: "command-1",
    result: "raw stdout\n",
  };
  const remove = registerStepBridge({
    effect: (given) => {
      requests.push(given);
      return Promise.resolve(result);
    },
    gate: () => Promise.resolve({ kind: "unavailable", reason: "unused" }),
  });
  try {
    assert.deepEqual(await runCommand(request), result);
    assert.deepEqual(requests, [
      {
        scope: request.scope,
        capability: "command",
        method: "run:review-requests",
        target: "review-requests",
        payload: JSON.stringify(request.input),
        units: 1,
      },
    ]);
  } finally {
    remove();
  }
});

await test("CLV-178 the command helper refuses an absent host", async () => {
  assert.deepEqual(await runCommand(request), {
    kind: "unavailable",
    reason: "cloving-host-unavailable",
  });
});
