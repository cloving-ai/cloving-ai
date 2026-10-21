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

type ReceiptKind = Awaited<ReturnType<ReconciliationPorts["submit"]>>["kind"];

function ports(scene: {
  readonly state: AuthorityState;
  readonly world: readonly WorldRun[];
  readonly receipts: readonly ReceiptKind[];
  readonly unreadable?: readonly string[];
}): ReconciliationPorts & {
  readonly submitted: string[];
  readonly outcomes: string[];
  readonly reads: string[];
} {
  const submitted: string[] = [];
  const outcomes: string[] = [];
  const reads: string[] = [];
  return {
    submitted,
    outcomes,
    reads,
    state: () => {
      reads.push("state");
      return Promise.resolve(scene.state);
    },
    runs: () => {
      reads.push("runs");
      return Promise.resolve(scene.world);
    },
    outcome: (receipt) => {
      outcomes.push(receipt);
      return scene.unreadable?.includes(receipt) === true
        ? Promise.reject(new Error("the World record is not readable"))
        : Promise.resolve({ kind: "handoff_requested" });
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
const unknown = { runId: "run-9", receipt: "wrun-9", status: "running" };
const unknownReport = {
  kind: "unknown-world-run",
  runId: "run-9",
  receipt: "wrun-9",
};

await test("CLV-056 after a storage-failure receipt of a reconciliation command the host sends the same command ID again after the reopen and gets the duplicate receipt", async () => {
  const failing = ports({
    state: running,
    world: [...world("failed"), unknown],
    receipts: ["failed"],
  });
  assert.deepEqual(await reconcileWorld(failing), {
    sent: ["observe:world-run-failed:wrun-1 failed"],
    interrupted: true,
    reports: [unknownReport],
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

await test("CLV-056 the product adapter reconciles a start with its operation ID, and it refuses an intent that is no run operation", async () => {
  const intent = {
    kind: "start-run",
    runId: "run-1",
    operationId: "operation-1",
    workflow: "sha256:pin",
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
      document: () => Promise.resolve(undefined),
      workflow: () => Promise.resolve(undefined),
      cancel: () => Promise.resolve("cancelled"),
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
    adapter([]).deliver({ ...intent, kind: "protected-effect" }),
    /unsupported-intent: protected-effect/,
  );
  await assert.rejects(
    adapter([]).deliver(intent),
    /start-not-available: run-1/,
  );
});

await test("CLV-056 the reconciliation loop keeps the reports of its last complete pass when a pass fails, it reports three failed passes in sequence, and it stops", async () => {
  const worlds = [...world("running"), unknown];
  const seen: unknown[] = [];
  const read = { reports: (): unknown => [] };
  const loop = worldLoop({
    ...ports({ state: running, world: worlds, receipts: [] }),
    intervalMilliseconds: 1,
    runs: () => {
      seen.push(read.reports());
      return seen.length === 1 || seen.length > 6
        ? Promise.resolve(worlds)
        : Promise.reject(new Error("the World is not readable"));
    },
  });
  read.reports = loop.reports;
  for (let waited = 0; waited < 2_000 && seen.length < 8; waited += 1)
    await delay(1);
  const failure = (count: number): unknown => ({
    kind: "world-reconciliation-failed",
    passes: count,
  });
  assert.deepEqual(
    [seen[0], seen[3], seen[4], seen[6], seen[7]],
    [
      [],
      [unknownReport],
      [unknownReport, failure(3)],
      [unknownReport, failure(5)],
      [unknownReport],
    ],
  );
  await loop.stop();
  const stopped = seen.length;
  await delay(20);
  assert.equal(seen.length, stopped);
});

const second = advanced(
  advanced(running, { ...admit, runId: "run-2", commandId: "c-second" }),
  {
    kind: "record-dispatch",
    runId: "run-2",
    operationId:
      '["cloving-operation",0,"run-2","admission","start-run",null,null]',
    receipt: "wrun-2",
  },
);

await test("CLV-056 a World run whose outcome the host cannot read gets a report, and the pass sends the commands of each other run", async () => {
  const scene = ports({
    state: second,
    world: [
      ...world("completed"),
      { runId: "run-2", receipt: "wrun-2", status: "running" },
    ],
    receipts: [],
    unreadable: ["wrun-1"],
  });
  assert.deepEqual(await reconcileWorld(scene), {
    sent: ["mark-started:wrun-2 accepted"],
    interrupted: false,
    reports: [
      { kind: "world-run-unreadable", runId: "run-1", receipt: "wrun-1" },
    ],
    conflicts: [],
  });
});

await test("CLV-056 a pass reads the World runs before the authority state, so that its state is not older than its World read", async () => {
  const scene = ports({
    state: running,
    world: world("running"),
    receipts: [],
  });
  await reconcileWorld(scene);
  assert.deepEqual(scene.reads, ["runs", "state"]);
});

await test("CLV-057 the product adapter cancels each World run of an operation that is not at an end, and it confirms the stop only when each one is at an end", async () => {
  const intent = {
    kind: "continue-run",
    runId: "run-1",
    operationId: "operation-1",
    workflow: "sha256:pin",
  };
  const stopped = async (
    statuses: readonly string[],
    afterCancel: string,
  ): Promise<unknown> => {
    const cancelled: string[] = [];
    const adapter = startDelivery({
      runs: () =>
        Promise.resolve(
          statuses.map((status, index) => ({
            receipt: `wrun-${String(index + 1)}`,
            operationId: "operation-1",
            status,
          })),
        ),
      input: () => Promise.resolve(undefined),
      document: () => Promise.resolve(undefined),
      workflow: () => Promise.resolve(undefined),
      cancel: (receipt) => {
        cancelled.push(receipt);
        return Promise.resolve(afterCancel);
      },
    });
    return [await adapter.stop(intent), cancelled];
  };
  assert.deepEqual(await stopped([], "cancelled"), [{ kind: "absent" }, []]);
  assert.deepEqual(await stopped(["running"], "cancelled"), [
    { kind: "stopped", receipt: "wrun-1" },
    ["wrun-1"],
  ]);
  for (const status of ["completed", "failed", "cancelled"])
    assert.deepEqual(await stopped([status], "running"), [
      { kind: "stopped", receipt: "wrun-1" },
      [],
    ]);
  assert.deepEqual(await stopped(["completed", "pending"], "running"), [
    { kind: "unknown", evidence: "world-run:wrun-2 running" },
    ["wrun-2"],
  ]);
});

await test("CLV-057 the reconciliation loop reports a conflict of two World runs with one operation ID", async () => {
  const twice = ["wrun-1", "wrun-2"].map((receipt) => ({
    runId: "run-1",
    receipt,
    status: "running",
    operationId: startOperation,
  }));
  const loop = worldLoop({
    ...ports({ state: running, world: twice, receipts: [] }),
    intervalMilliseconds: 1,
  });
  for (
    let waited = 0;
    waited < 2_000 && loop.reports().length === 0;
    waited += 1
  )
    await delay(1);
  await loop.stop();
  assert.deepEqual(loop.reports(), [
    { kind: "world-run-conflict", runId: "run-1" },
  ]);
});
