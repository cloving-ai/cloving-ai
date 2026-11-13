import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerReconciliation } from "../src/daemon/worker-reconciliation.ts";
import type { AdapterOutcome } from "../src/broker/actor/delivery-intents.ts";

await test("CLV-365 stop cancels pending recovery before it waits for the outcome", async () => {
  const desk = new WorkerReconciliation();
  const gate = Promise.withResolvers<AdapterOutcome>();
  let observed: AbortSignal | undefined;
  const running = desk.run("operation", {
    signal: new AbortController().signal,
    perform: (signal) => {
      observed = signal;
      return gate.promise;
    },
  });
  const stopped = desk.stop("operation", {
    cancelPending: true,
    record: () => Promise.resolve(),
    perform: () => Promise.resolve({ kind: "stopped" }),
  });
  try {
    assert.equal(observed?.aborted, true);
  } finally {
    gate.resolve({ kind: "accepted", worker: "pi", receipt: "operation" });
    await running;
    await stopped;
  }
});

await test("CLV-365 concurrent recovery and duplicate drop cannot enter while a stop is recorded", async () => {
  const desk = new WorkerReconciliation();
  const gate = Promise.withResolvers<undefined>();
  let records = 0;
  const request = {
    record: async () => {
      records += 1;
      await gate.promise;
    },
    perform: () => Promise.resolve<AdapterOutcome>({ kind: "stopped" }),
  };
  const stopping = desk.stop("operation", request);
  const duplicate = desk.stop("operation", request);
  const recovery = desk.run("operation", {
    signal: new AbortController().signal,
    perform: () => {
      throw new Error("Replacement started during drop");
    },
  });
  assert.equal(records, 1);
  assert.equal(stopping, duplicate);
  assert.equal(stopping, recovery);
  gate.resolve(undefined);
  assert.equal((await stopping).kind, "stopped");
});

await test("CLV-365 a legacy stop preserves recovery settlement after a rejected request", async () => {
  const desk = new WorkerReconciliation();
  const gate = Promise.withResolvers<AdapterOutcome>();
  let observed: AbortSignal | undefined;
  const running = desk.run("operation", {
    signal: new AbortController().signal,
    perform: (signal) => {
      observed = signal;
      return gate.promise;
    },
  });
  const stopped = desk.stop("operation", {
    perform: () => Promise.resolve({ kind: "stopped" }),
  });
  assert.equal(observed?.aborted, false);
  gate.reject(new Error("Lost recovery"));
  await assert.rejects(running, /Lost recovery/);
  assert.equal((await stopped).kind, "stopped");
});
