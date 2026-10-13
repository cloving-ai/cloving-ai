import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WorldRun } from "../src/authority/reconciliation.ts";
import {
  emptyAuthority,
  execute,
  type AuthorityState,
} from "../src/authority/reducer.ts";
import { startDelivery } from "../src/host/start-delivery.ts";
import {
  reconcileWorld,
  worldLoop,
  type ReconciliationPorts,
} from "../src/host/world-reconciliation.ts";
import { admit, lastState, recorded } from "./authority-fixture.ts";

const startOperation =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';

function advanced(
  state: AuthorityState,
  command: Readonly<Record<string, unknown>>,
): AuthorityState {
  const result = execute(state, {
    command: { commandId: `k-${String(state.sequence)}`, ...command },
    ...recorded,
  });
  assert.equal(result.kind, "accepted", JSON.stringify(result));
  return lastState([result]);
}

const queued = advanced(advanced(emptyAuthority, admit), {
  kind: "record-dispatch",
  runId: "run-1",
  operationId: startOperation,
  receipt: "wrun-1",
});
const running = advanced(queued, {
  kind: "mark-started",
  runId: "run-1",
  expectedRevision: 1,
});

function ports(scene: {
  readonly state: AuthorityState;
  readonly world: readonly WorldRun[];
  readonly receipts: readonly string[];
}): ReconciliationPorts & {
  readonly submitted: string[];
  readonly outcomes: string[];
} {
  const submitted: string[] = [];
  const outcomes: string[] = [];
  return {
    submitted,
    outcomes,
    state: () => Promise.resolve(scene.state),
    runs: () => Promise.resolve(scene.world),
    outcome: (receipt) => {
      outcomes.push(receipt);
      return Promise.resolve("handoff_requested");
    },
    submit: (command) => {
      submitted.push(String(command["commandId"]));
      return Promise.resolve({
        kind: scene.receipts[submitted.length - 1] ?? "accepted",
      });
    },
  };
}

const world = (status: string): WorldRun[] => [
  { runId: "run-1", receipt: "wrun-1", status },
];

await test("CLV-056 after a storage-failure receipt of a reconciliation command the host sends the same command ID again after the reopen and gets the duplicate receipt", async () => {
  const failing = ports({
    state: running,
    world: world("failed"),
    receipts: ["storage-failure"],
  });
  assert.deepEqual(await reconcileWorld(failing), {
    sent: ["observe:world-run-failed:wrun-1 storage-failure"],
    interrupted: true,
    reports: [],
    conflicts: [],
  });
  const reopened = ports({
    state: running,
    world: world("failed"),
    receipts: ["duplicate", "accepted"],
  });
  assert.deepEqual(await reconcileWorld(reopened), {
    sent: [
      "observe:world-run-failed:wrun-1 duplicate",
      "fail-run:wrun-1 accepted",
    ],
    interrupted: false,
    reports: [],
    conflicts: [],
  });
  assert.deepEqual(failing.submitted, ["observe:world-run-failed:wrun-1"]);
});

await test("CLV-056 the reconciliation caller sends the commands of the pure plan only, and it reads the outcome of a completed World run only for a run in work", async () => {
  const started = ports({
    state: queued,
    world: world("completed"),
    receipts: [],
  });
  assert.deepEqual((await reconcileWorld(started)).sent, [
    "mark-started:wrun-1 accepted",
  ]);
  assert.deepEqual(started.outcomes, []);
  const ended = ports({
    state: running,
    world: [
      ...world("completed"),
      { runId: "run-9", receipt: "wrun-9", status: "completed" },
    ],
    receipts: ["rejected"],
  });
  assert.deepEqual(await reconcileWorld(ended), {
    sent: ["complete-run:wrun-1 rejected"],
    interrupted: false,
    reports: [{ kind: "unknown-world-run", runId: "run-9", receipt: "wrun-9" }],
    conflicts: [],
  });
  assert.deepEqual(ended.outcomes, ["wrun-1"]);
  const unread = {
    ...ports({ state: running, world: world("completed"), receipts: [] }),
    outcome: () => Promise.resolve(undefined),
  };
  assert.deepEqual((await reconcileWorld(unread)).sent, [
    "complete-run:wrun-1 accepted",
  ]);
  const idle = ports({ state: running, world: world("running"), receipts: [] });
  assert.deepEqual((await reconcileWorld(idle)).sent, []);
});

await test("CLV-056 the product adapter reconciles a start with its operation ID, and it refuses a continuation", async () => {
  const intent = {
    kind: "start-run",
    runId: "run-1",
    operationId: "operation-1",
  };
  const tagged = (receipt: string, operationId: string | null) => ({
    runId: "run-1",
    receipt,
    status: "running",
    operationId,
  });
  const adapter = (runs: readonly ReturnType<typeof tagged>[]) =>
    startDelivery({
      runs: () => Promise.resolve(runs),
      input: () => Promise.resolve(undefined),
      workflow: () => Promise.resolve(undefined),
    });
  assert.deepEqual(await adapter([]).reconcile(intent), { kind: "absent" });
  assert.deepEqual(
    await adapter([
      tagged("wrun-2", "operation-2"),
      tagged("wrun-3", null),
    ]).reconcile(intent),
    { kind: "absent" },
  );
  assert.deepEqual(
    await adapter([
      tagged("wrun-1", "operation-1"),
      tagged("wrun-2", "operation-2"),
    ]).reconcile(intent),
    { kind: "accepted", receipt: "wrun-1" },
  );
  assert.deepEqual(
    await adapter([
      tagged("wrun-1", "operation-1"),
      tagged("wrun-4", "operation-1"),
    ]).reconcile(intent),
    { kind: "unknown", evidence: "world-run:wrun-1 world-run:wrun-4" },
  );
  await assert.rejects(
    adapter([]).deliver({ ...intent, kind: "continue-run" }),
    /unsupported-intent: continue-run/,
  );
  await assert.rejects(
    adapter([]).deliver(intent),
    /start-not-available: run-1/,
  );
});

await test("CLV-056 the reconciliation loop keeps the reports of its last complete pass when a pass fails, and it stops", async () => {
  const unknown = { runId: "run-9", receipt: "wrun-9", status: "running" };
  let passes = 0;
  const scene = ports({ state: running, world: [unknown], receipts: [] });
  const loop = worldLoop({
    ...scene,
    intervalMilliseconds: 1,
    runs: () => {
      passes += 1;
      return passes === 2
        ? Promise.reject(new Error("the World is not readable"))
        : Promise.resolve([unknown]);
    },
  });
  assert.deepEqual(loop.reports(), []);
  for (let waited = 0; waited < 2_000 && passes < 4; waited += 1)
    await delay(1);
  assert.deepEqual(loop.reports(), [
    { kind: "unknown-world-run", runId: "run-9", receipt: "wrun-9" },
  ]);
  await loop.stop();
  const stopped = passes;
  await delay(20);
  assert.equal(passes, stopped);
});
