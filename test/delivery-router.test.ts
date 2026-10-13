import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import { deliveryRouter } from "../src/daemon/delivery-router.ts";

function intent(kind: DeliveryIntent["kind"]): DeliveryIntent {
  return {
    kind,
    runId: "run-1",
    operationId: `operation-${kind}`,
    workflow: "sha256:pin",
    inputDigest: "sha256:input",
    purpose: "dispatch",
  };
}

function routes(): {
  readonly calls: string[];
  readonly router: ReturnType<typeof deliveryRouter>;
} {
  const calls: string[] = [];
  const noted = (name: string, given: { readonly operationId: string }) => {
    calls.push(`${name} ${given.operationId}`);
  };
  const router = deliveryRouter({
    runs: {
      deliver: (given) => {
        noted("runs.deliver", given);
        return Promise.resolve({ receipt: "wrun-1" });
      },
      reconcile: (given) => {
        noted("runs.reconcile", given);
        return Promise.resolve({ kind: "absent" });
      },
      stop: (given) => {
        noted("runs.stop", given);
        return Promise.resolve({ kind: "stopped", receipt: "wrun-1" });
      },
    },
    effects: {
      deliver: (given) => {
        noted("effects.deliver", given);
        return Promise.resolve({ receipt: "turn-1", worker: "claude" });
      },
      reconcile: (given) => {
        noted("effects.reconcile", given);
        return Promise.resolve({ kind: "unknown" });
      },
      stop: (given) => {
        noted("effects.stop", given);
        return Promise.resolve({ kind: "absent" });
      },
    },
  });
  return { calls, router };
}

await test("CLV-010 the delivery router gives a start and a continuation to the SDK start adapter, and a protected effect to the worker", async () => {
  const { calls, router } = routes();
  const signal = new AbortController().signal;
  const replies: unknown[] = [];
  for (const kind of [
    "start-run",
    "continue-run",
    "protected-effect",
  ] as const) {
    replies.push(await router.reconcile(intent(kind), signal));
    replies.push(await router.deliver(intent(kind), signal));
    replies.push(await router.stop?.(intent(kind), signal));
  }
  assert.deepEqual(calls, [
    "runs.reconcile operation-start-run",
    "runs.deliver operation-start-run",
    "runs.stop operation-start-run",
    "runs.reconcile operation-continue-run",
    "runs.deliver operation-continue-run",
    "runs.stop operation-continue-run",
    "effects.reconcile operation-protected-effect",
    "effects.deliver operation-protected-effect",
    "effects.stop operation-protected-effect",
  ]);
  assert.deepEqual(replies.slice(0, 3), [
    { kind: "absent" },
    { receipt: "wrun-1" },
    { kind: "stopped", receipt: "wrun-1" },
  ]);
  assert.deepEqual(replies.slice(6), [
    { kind: "unknown" },
    { receipt: "turn-1", worker: "claude" },
    { kind: "absent" },
  ]);
});
