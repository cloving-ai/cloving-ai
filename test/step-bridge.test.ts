import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
const timing = { lookupTries: 3, pollMilliseconds: 1, retryMilliseconds: 2 };

function scoped(scope: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(scope))
    .digest("hex")
    .slice(0, 16);
}

const commandId = `sdk:step_01ABC:${scoped(request.scope)}`;

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
const unread: BridgeReply = {
  receipt: { kind: "accepted" },
  disposition: null,
  operation: null,
};
const lost: BridgeReply = {
  receipt: { kind: "failed", reason: "storage-failure" },
  disposition: null,
  operation: null,
};
const busy: BridgeReply = {
  receipt: { kind: "rejected", reason: "service-busy" },
  disposition: null,
  operation: null,
};

type Fault = "fault";
const unstored = "a fault of the document read";

function taken<Value>(entries: (Value | Fault)[]): Promise<Value> {
  const entry = entries.length > 1 ? entries.shift() : entries[0];
  return entry === "fault" || entry === undefined
    ? Promise.reject(new Error("the authority is closed"))
    : Promise.resolve(entry);
}

function scene(script: {
  readonly call?: typeof call;
  readonly absentReads?: number;
  readonly states?: readonly string[];
  readonly reply?: BridgeReply;
  readonly replies?: readonly (BridgeReply | Fault)[];
  readonly operations?: readonly (OperationRead | Fault | "absent")[];
  readonly documents?: readonly string[];
  readonly stopped?: AbortSignal;
}): BridgePorts & {
  readonly log: string[];
  readonly requests: BridgeRequest[];
} {
  const log: string[] = [];
  const requests: BridgeRequest[] = [];
  const states = [...(script.states ?? ["running"])];
  const replies = [...(script.replies ?? [script.reply ?? accepted])];
  const operations = [...(script.operations ?? [operation("completed")])];
  const documents = [...(script.documents ?? ["text of sha256:result"])];
  return {
    log,
    requests,
    call: () => script.call ?? call,
    timing,
    stopped: script.stopped ?? new AbortController().signal,
    run: (worldRunId) => {
      log.push(`run ${worldRunId}`);
      const stored = script.absentReads ?? 0;
      const reads = log.filter((entry) => entry.startsWith("run ")).length;
      return Promise.resolve(
        worldRunId === "wrun_1" && reads > stored
          ? { runId: "run-1" }
          : undefined,
      );
    },
    state: async () => {
      const status = await taken(states);
      log.push(`state ${status}`);
      return { runs: { "run-1": { status, revision: 2 } }, gates: {} };
    },
    openGate: () => Promise.resolve({ kind: "accepted" }),
    registerWait: () => Promise.resolve({ kind: "accepted" }),
    requestEffect: (asked) => {
      log.push("request");
      requests.push(asked);
      return taken(replies);
    },
    operation: async () => {
      const next = await taken(operations);
      log.push(`operation ${next === "absent" ? next : next.status}`);
      return next === "absent" ? undefined : next;
    },
    document: async () => {
      const read = await taken(documents);
      return read === unstored ? taken<string>([]) : read;
    },
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
    "run wrun_1",
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
      commandId,
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
        receipt: { kind: "rejected", reason: "run-not-running" },
      },
    }),
    { kind: "refused", reason: "run-not-running" },
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
  assert.deepEqual(
    await result({ reply: { ...accepted, receipt: { kind: "rejected" } } }),
    { kind: "refused", reason: "rejected" },
  );
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
    odd.requests.map((asked) => [asked.commandId, asked.transport]),
    [[`sdk:step-01-ABC:${scoped(request.scope)}`, "sdk:step-01-ABC"]],
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

await test("CLV-059 the bridge keeps a request whose outcome it does not know, and it sends the same command ID again until the authority gives the stored reply", async () => {
  const held = scene({
    replies: [
      lost,
      "fault",
      unread,
      busy,
      { ...accepted, receipt: { kind: "duplicate" } },
    ],
    operations: [
      "fault",
      "absent",
      operation("running"),
      operation("completed"),
    ],
    documents: [unstored, "the stored result"],
  });
  assert.deepEqual(await stepBridge(held).effect(request), {
    kind: "completed",
    operationId: "operation-1",
    receipt: "receipt-1",
    result: "the stored result",
  });
  assert.deepEqual(
    held.requests.map((asked) => asked.commandId),
    [commandId, commandId, commandId, commandId, commandId],
  );
  assert.deepEqual(
    held.log.filter((entry) => entry.startsWith("operation ")),
    ["operation absent", "operation running", "operation completed"],
  );
});

await test("CLV-059 the bridge waits for a state read that fails, and an operation with no stored result gives a null result text", async () => {
  const closed = scene({ states: ["fault", "fault", "queued", "running"] });
  await stepBridge(closed).effect(request);
  assert.deepEqual(closed.log.slice(0, 4), [
    "run wrun_1",
    "state queued",
    "state running",
    "request",
  ]);
  const bare = scene({
    operations: [{ ...operation("completed"), result: null }],
  });
  assert.deepEqual(await stepBridge(bare).effect(request), {
    kind: "completed",
    operationId: "operation-1",
    receipt: "receipt-1",
    result: null,
  });
});

await test("CLV-059 after the host stops the bridge, a request in work gets no result and the bridge sends no more command", async () => {
  const stopping = new AbortController();
  const held = scene({ replies: [lost], stopped: stopping.signal });
  const outcome = { settled: "no" };
  const settle = (): void => {
    outcome.settled = "yes";
  };
  void stepBridge(held).effect(request).then(settle, settle);
  while (held.requests.length < 3) await delay(1);
  stopping.abort();
  await delay(10);
  const sent = held.requests.length;
  await delay(30);
  assert.deepEqual([outcome.settled, held.requests.length], ["no", sent]);
  const late = scene({ stopped: stopping.signal });
  void stepBridge(late).effect(request).then(settle, settle);
  await delay(20);
  assert.deepEqual([outcome.settled, late.requests], ["no", []]);
});

await test("CLV-059 two requests of one step with two scopes have two command IDs, and a second try of one scope has the same command ID", async () => {
  const ports = scene({});
  const bridge = stepBridge(ports);
  const second = { ...request, scope: { ...request.scope, round: 2 } };
  await bridge.effect(request);
  await bridge.effect(second);
  await bridge.effect(request);
  assert.deepEqual(
    ports.requests.map((asked) => [asked.commandId, asked.transport]),
    [
      [commandId, "sdk:step_01ABC"],
      [`sdk:step_01ABC:${scoped(second.scope)}`, "sdk:step_01ABC"],
      [commandId, "sdk:step_01ABC"],
    ],
  );
  assert.notEqual(scoped(second.scope), scoped(request.scope));
});

await test("CLV-058 the bridge reads the record of its SDK run again, with a bound, when the record is not stored at the first instant of the step", async () => {
  const late = scene({ absentReads: 2 });
  assert.deepEqual(await stepBridge(late).effect(request), {
    kind: "completed",
    operationId: "operation-1",
    receipt: "receipt-1",
    result: "text of sha256:result",
  });
  assert.deepEqual(late.log.slice(0, 4), [
    "run wrun_1",
    "run wrun_1",
    "run wrun_1",
    "state running",
  ]);
  const never = scene({ absentReads: 9 });
  assert.deepEqual(await stepBridge(never).effect(request), {
    kind: "unavailable",
    reason: "unknown-world-run",
  });
  assert.deepEqual(never.log, ["run wrun_1", "run wrun_1", "run wrun_1"]);
  assert.deepEqual(never.requests, []);
});
