import assert from "node:assert/strict";
import { test } from "node:test";
import { continueRun } from "../src/steps/continue-run.ts";
import { handoff } from "../src/steps/handoff.ts";
import { stepBridgeKey, type ProtectedResult } from "../src/step-bridge.ts";

await test("CLV-182 handoff exposes the admitted run ID and fails explicitly without a host or result", async () => {
  const key = Symbol.for(stepBridgeKey);
  const previous: unknown = Reflect.get(globalThis, key);
  const request = { workflowId: "B", input: { prompt: "next" } };
  try {
    Reflect.deleteProperty(globalThis, key);
    await assert.rejects(handoff(request), /cloving-host-unavailable/);
    const unavailable = () =>
      Promise.resolve({ kind: "unavailable", reason: "synthetic" });
    const bridge = { effect: unavailable, gate: unavailable };
    Reflect.set(globalThis, key, bridge);
    await assert.rejects(handoff(request), /cloving-host-unavailable/);
    let result: ProtectedResult = {
      kind: "completed",
      operationId: "op",
      receipt: "run-B",
      result: "run-B",
    };
    Reflect.set(globalThis, key, {
      ...bridge,
      handoff: (given: unknown) => {
        assert.deepEqual(given, request);
        return Promise.resolve(result);
      },
    });
    assert.equal(await handoff(request), "run-B");
    result = { ...result, result: null };
    await assert.rejects(handoff(request), /handoff-result-missing/);
    result = { kind: "refused", reason: "handoff-not-declared" };
    await assert.rejects(handoff(request), /handoff-not-declared/);
    result = { kind: "stopped", operationId: "op", reason: null };
    await assert.rejects(handoff(request), /stopped/);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});

await test("CLV-307 continueRun exposes the continuation run ID and fails explicitly without a host or result", async () => {
  const key = Symbol.for(stepBridgeKey);
  const previous: unknown = Reflect.get(globalThis, key);
  const request = { runId: "run-child", from: "merge/merge" };
  try {
    Reflect.deleteProperty(globalThis, key);
    await assert.rejects(continueRun(request), /cloving-host-unavailable/);
    const unavailable = () =>
      Promise.resolve({ kind: "unavailable", reason: "synthetic" });
    const bridge = { effect: unavailable, gate: unavailable };
    Reflect.set(globalThis, key, bridge);
    await assert.rejects(continueRun(request), /cloving-host-unavailable/);
    let result: ProtectedResult = {
      kind: "completed",
      operationId: "op",
      receipt: "run-next",
      result: "run-next",
    };
    Reflect.set(globalThis, key, {
      ...bridge,
      continueRun: (given: unknown) => {
        assert.deepEqual(given, request);
        return Promise.resolve(result);
      },
    });
    assert.equal(await continueRun(request), "run-next");
    result = { ...result, result: null };
    await assert.rejects(continueRun(request), /continuation-result-missing/);
    result = { kind: "failed", operationId: "op", reason: "run-active" };
    await assert.rejects(continueRun(request), /run-active/);
    result = { kind: "stopped", operationId: "op", reason: null };
    await assert.rejects(continueRun(request), /stopped/);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});
