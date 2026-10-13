import assert from "node:assert/strict";
import { test } from "node:test";
import { protectedEffect } from "../src/steps/protected-effect.ts";
import {
  registerStepBridge,
  stepBridge,
  type BridgePorts,
  type BridgeReply,
  type BridgeRequest,
  type OperationRead,
} from "../src/host/step-bridge-host.ts";

const request = {
  scope: { phase: "work", operation: "effect", round: 1 },
  capability: "fake-harness",
  method: "run-turn",
  target: "workspace/main",
  payload: "build the package",
  units: 1,
};
const call = { worldRunId: "wrun_1", stepId: "step_01ABC", attempt: 2 };
const spaced = { ...call, stepId: "step 01#ABC" };

function operation(
  status: string,
  reason: string | null = null,
): OperationRead {
  return {
    operationId: "operation-1",
    status,
    reason,
    receipt: status === "completed" ? "receipt-1" : null,
    result: status === "completed" ? "sha256:result" : null,
  };
}

const accepted: BridgeReply = {
  receipt: { kind: "accepted" },
  disposition: { disposition: "granted", reason: null },
  operation: operation("running"),
};

function scene(script: {
  readonly call?: typeof call;
  readonly states?: readonly string[];
  readonly reply?: BridgeReply;
  readonly operations?: readonly OperationRead[];
}): BridgePorts & {
  readonly log: string[];
  readonly requests: BridgeRequest[];
} {
  const log: string[] = [];
  const requests: BridgeRequest[] = [];
  const states = [...(script.states ?? ["running"])];
  const operations = [...(script.operations ?? [operation("completed")])];
  return {
    log,
    requests,
    call: () => script.call ?? call,
    runs: () => Promise.resolve([{ runId: "run-1", receipt: "wrun_1" }]),
    state: () => {
      const status = states.length > 1 ? states.shift() : states[0];
      log.push(`state ${String(status)}`);
      return Promise.resolve({ runs: { "run-1": { status: String(status) } } });
    },
    requestEffect: (asked) => {
      log.push("request");
      requests.push(asked);
      return Promise.resolve(script.reply ?? accepted);
    },
    operation: () => {
      const next = operations.length > 1 ? operations.shift() : operations[0];
      log.push(`operation ${String(next?.status)}`);
      return Promise.resolve(next);
    },
    document: (digest) => Promise.resolve(`text of ${digest}`),
  };
}

await test("CLV-058 the bridge requests the effect only when the authority shows the run in work, with the SDK step as the command ID and the transport, and it returns the stored result", async () => {
  const ports = scene({
    states: ["queued", "queued", "running"],
    operations: [
      operation("dispatch-pending"),
      operation("running"),
      operation("completed"),
    ],
  });
  assert.deepEqual(await stepBridge(ports).effect(request), {
    kind: "completed",
    operationId: "operation-1",
    receipt: "receipt-1",
    result: "text of sha256:result",
  });
  assert.deepEqual(ports.log, [
    "state queued",
    "state queued",
    "state running",
    "request",
    "operation dispatch-pending",
    "operation running",
    "operation completed",
  ]);
  assert.deepEqual(ports.requests, [
    {
      ...request,
      runId: "run-1",
      commandId: "sdk:step_01ABC",
      transport: "sdk:step_01ABC",
    },
  ]);
});

await test("CLV-058 the bridge gives a typed result for a request that the authority does not accept, for a refused request and for an operation that ends with no result", async () => {
  const result = (script: Parameters<typeof scene>[0]): Promise<unknown> =>
    stepBridge(scene(script)).effect(request);
  assert.deepEqual(
    await result({
      reply: {
        ...accepted,
        receipt: { kind: "rejected", reason: "service-busy" },
      },
    }),
    { kind: "refused", reason: "service-busy" },
  );
  assert.deepEqual(
    await result({
      reply: {
        ...accepted,
        disposition: { disposition: "refused", reason: "budget-exhausted" },
      },
    }),
    { kind: "refused", reason: "budget-exhausted" },
  );
  assert.deepEqual(await result({ reply: { ...accepted, operation: null } }), {
    kind: "refused",
    reason: "no-operation",
  });
  for (const kind of ["failed", "stopped", "blocked", "cancelled"])
    assert.deepEqual(
      await result({ operations: [operation(kind, "outcome-unknown")] }),
      { kind, operationId: "operation-1", reason: "outcome-unknown" },
    );
  assert.deepEqual(
    await result({
      operations: [operation("refused", "capability-not-pinned")],
    }),
    { kind: "refused", reason: "capability-not-pinned" },
  );
  assert.deepEqual(await result({ call: { ...call, worldRunId: "wrun_9" } }), {
    kind: "unavailable",
    reason: "unknown-world-run",
  });
  const odd = scene({ call: spaced });
  await stepBridge(odd).effect(request);
  assert.deepEqual(
    odd.requests.map((asked) => asked.commandId),
    ["sdk:step-01-ABC"],
  );
  assert.deepEqual(await result({ states: ["completed"] }), {
    kind: "completed",
    operationId: "operation-1",
    receipt: "receipt-1",
    result: "text of sha256:result",
  });
});

await test("CLV-058 the step helper gives its request to the bridge of its process, and it reports the absent host after the bridge is removed", async () => {
  const ports = scene({});
  const remove = registerStepBridge(stepBridge(ports));
  assert.deepEqual(await protectedEffect(request), {
    kind: "completed",
    operationId: "operation-1",
    receipt: "receipt-1",
    result: "text of sha256:result",
  });
  assert.equal(ports.requests.length, 1);
  remove();
  assert.deepEqual(await protectedEffect(request), {
    kind: "unavailable",
    reason: "cloving-host-unavailable",
  });
  assert.equal(ports.requests.length, 1);
});

await test("CLV-059 the bridge gives no result for a receipt of the kind failed, and each try of a step sends the same command ID", async () => {
  const unknown = scene({
    reply: {
      receipt: { kind: "failed", reason: "storage-failure" },
      disposition: null,
      operation: null,
    },
  });
  await assert.rejects(
    stepBridge(unknown).effect(request),
    /command-outcome-unknown: storage-failure/,
  );
  await assert.rejects(
    stepBridge(
      scene({ reply: { ...accepted, receipt: { kind: "failed" } } }),
    ).effect(request),
    /command-outcome-unknown: failed/,
  );
  assert.deepEqual(
    await stepBridge(
      scene({ reply: { ...accepted, receipt: { kind: "rejected" } } }),
    ).effect(request),
    { kind: "refused", reason: "rejected" },
  );
  const again = scene({
    call: { ...call, attempt: 3 },
    reply: { ...accepted, receipt: { kind: "duplicate" } },
  });
  assert.deepEqual(await stepBridge(again).effect(request), {
    kind: "completed",
    operationId: "operation-1",
    receipt: "receipt-1",
    result: "text of sha256:result",
  });
  assert.deepEqual(
    [...unknown.requests, ...again.requests].map((asked) => asked.commandId),
    ["sdk:step_01ABC", "sdk:step_01ABC"],
  );
});
