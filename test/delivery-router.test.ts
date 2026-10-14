import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import { deliveryRouter } from "../src/daemon/delivery-router.ts";

function intent(
  kind: DeliveryIntent["kind"],
  capability = "claude",
): DeliveryIntent {
  return {
    kind,
    runId: "run-1",
    operationId: `operation-${kind}`,
    workflow: "sha256:pin",
    inputDigest: "sha256:input",
    purpose: "dispatch",
    capability,
  };
}

function worker(
  name: string,
  noted: (name: string, given: { readonly operationId: string }) => void,
): Parameters<typeof deliveryRouter>[0]["effects"][string] {
  return {
    deliver: (given) => {
      noted(`${name}.deliver`, given);
      return Promise.resolve({ receipt: `${name}-1`, worker: name });
    },
    reconcile: (given) => {
      noted(`${name}.reconcile`, given);
      return Promise.resolve({ kind: "unknown" });
    },
    stop: (given) => {
      noted(`${name}.stop`, given);
      return Promise.resolve({ kind: "absent" });
    },
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
      claude: worker("claude", noted),
      github: worker("github", noted),
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
    "claude.reconcile operation-protected-effect",
    "claude.deliver operation-protected-effect",
    "claude.stop operation-protected-effect",
  ]);
  assert.deepEqual(replies.slice(0, 3), [
    { kind: "absent" },
    { receipt: "wrun-1" },
    { kind: "stopped", receipt: "wrun-1" },
  ]);
  assert.deepEqual(replies.slice(6), [
    { kind: "unknown" },
    { receipt: "claude-1", worker: "claude" },
    { kind: "absent" },
  ]);
});

await test("CLV-063 the delivery router gives a protected effect to the worker of its capability, and refuses an effect that has no worker", async () => {
  const { calls, router } = routes();
  const signal = new AbortController().signal;
  const github = intent("protected-effect", "github");
  assert.deepEqual(await router.deliver(github, signal), {
    receipt: "github-1",
    worker: "github",
  });
  await router.reconcile(github, signal);
  await router.stop?.(github, signal);
  assert.deepEqual(calls, [
    "github.deliver operation-protected-effect",
    "github.reconcile operation-protected-effect",
    "github.stop operation-protected-effect",
  ]);
  const unknown = intent("protected-effect", "mail");
  const refused = { kind: "failed", reason: "unsupported-effect" };
  assert.deepEqual(
    [
      await router.deliver(unknown, signal),
      await router.reconcile(unknown, signal),
      await router.stop?.(unknown, signal),
    ],
    [refused, refused, refused],
  );
  assert.equal(calls.length, 3);
});
