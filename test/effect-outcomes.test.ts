import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectRequest,
  noon,
  runningRun,
  sender,
  type Request,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

type Reply = (intent: DeliveryIntent) => Promise<AdapterOutcome>;

interface Script {
  readonly reconcile?: Reply;
  readonly deliver?: Reply;
}

interface Scripted {
  readonly delivery: Delivery;
  readonly calls: string[];
}

const absent: AdapterOutcome = { kind: "absent" };

const defaults: Readonly<Record<string, AdapterOutcome>> = {
  "reconcile reconcile": { kind: "unknown" },
  "deliver dispatch": {
    kind: "accepted",
    receipt: "receipt-1",
    worker: "worker-1",
  },
};

function scripted(script: Script): Scripted {
  const calls: string[] = [];
  const reply = (name: "reconcile" | "deliver"): Reply => {
    return (intent) => {
      if (intent.kind !== "protected-effect") return Promise.resolve(absent);
      calls.push(name);
      const scriptedReply = script[name];
      if (scriptedReply !== undefined) return scriptedReply(intent);
      return Promise.resolve(defaults[`${name} ${intent.purpose}`] ?? absent);
    };
  };
  return {
    calls,
    delivery: { reconcile: reply("reconcile"), deliver: reply("deliver") },
  };
}

interface Scene {
  readonly authority: Authority;
  readonly request: Request;
  readonly calls: readonly string[];
}

async function scene(script: Script): Promise<Scene> {
  const adapter = scripted(script);
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter.delivery,
    clock: () => noon,
    timing: fastTiming,
    effects: { adapterMilliseconds: 80, resultBytes: 64 },
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  await send(request.command, request.documents);
  return { authority, request, calls: adapter.calls };
}

async function closed(started: Scene): Promise<readonly unknown[]> {
  const { authority, request } = started;
  const { operationId } = request;
  await deliverUntil(authority, async () => {
    const records = await authority.operations();
    return records.some(
      (record) =>
        record.operationId === operationId &&
        record.deliveries.some((item) => item.outcome !== null),
    );
  });
  const operation = await authority.effects.operation(operationId);
  const records = await authority.operations();
  return [
    operation?.status,
    operation?.reason,
    operation?.result,
    operation?.attempts,
    operation?.leaseGeneration,
    records
      .filter((record) => record.operationId === operationId)
      .flatMap((record) => record.deliveries.map((item) => item.outcome)),
    [operation?.receipt, operation?.worker],
    records
      .filter((record) => record.operationId === operationId)
      .flatMap((record) => record.deliveries.map((item) => item.receipt)),
  ];
}

const resolved = (outcome: AdapterOutcome): Reply => {
  return () => Promise.resolve(outcome);
};

for (const [name, outcome, expected, document] of [
  [
    "completed",
    {
      kind: "completed",
      receipt: "receipt-1",
      worker: "worker-1",
      result: "the result",
    },
    [
      "completed",
      null,
      digestOf("the result"),
      0,
      null,
      ["completed"],
      ["receipt-1", "worker-1"],
      ["receipt-1"],
    ],
    "the result",
  ],
  [
    "failed",
    { kind: "failed", receipt: "receipt-1", reason: "tool-exit" },
    [
      "failed",
      "tool-exit",
      null,
      0,
      null,
      ["failed"],
      ["receipt-1", null],
      ["receipt-1"],
    ],
    undefined,
  ],
  [
    "stopped",
    { kind: "stopped" },
    ["stopped", null, null, 0, null, ["stopped"], [null, null], [null]],
    undefined,
  ],
] as const)
  await test(`CLV-049 a delivery reply ${name} settles the operation with its result or its reason and releases its lease, and a reconciliation with that reply does the same with no send`, async () => {
    const sent = await scene({ deliver: resolved(outcome) });
    assert.deepEqual(await closed(sent), expected);
    assert.deepEqual(sent.calls, ["reconcile", "deliver"]);
    assert.deepEqual(await sent.authority.eligibleIntents(), []);
    assert.equal(
      await sent.authority.queries.document(digestOf("the result")),
      document,
    );
    await sent.authority.close();
    const found = await scene({ reconcile: resolved(outcome) });
    assert.deepEqual(await closed(found), expected);
    assert.deepEqual(found.calls, ["reconcile"]);
    await found.authority.close();
  });

async function bounded(started: Scene): Promise<readonly unknown[]> {
  const { authority, request } = started;
  const { operationId } = request;
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "blocked",
  );
  const operation = await authority.effects.operation(operationId);
  const outcomes = (await authority.events())
    .filter((event) => event.type === "operation.reconciled")
    .map((event) => [event.payload["outcome"], event.payload["reason"]]);
  return [
    operation?.reason,
    operation?.attempts,
    operation?.leaseGeneration,
    outcomes[0],
    outcomes.length,
  ];
}

function inherited(kind: string): AdapterOutcome {
  return Object.assign(
    { kind: "unknown" as const },
    Object.fromEntries([["kind", kind]]),
  );
}

const sent = ["reconcile", "deliver", "reconcile", "reconcile"];
const unsent = ["reconcile", "reconcile", "reconcile"];

for (const [name, script, expected] of [
  [
    "a delivery reply unknown",
    { deliver: resolved({ kind: "unknown", evidence: "no trace" }) },
    { reason: "adapter-unknown", calls: sent },
  ],
  [
    "a reconciliation reply unknown",
    { reconcile: resolved({ kind: "unknown" }) },
    { reason: "adapter-unknown", calls: unsent },
  ],
  [
    "an acceptance with no worker identity",
    { deliver: resolved({ kind: "accepted", receipt: "receipt-1" }) },
    { reason: "invalid-adapter-reply", calls: sent },
  ],
  [
    "an acceptance with a worker identity that is not an identifier",
    {
      deliver: resolved({
        kind: "accepted",
        receipt: "receipt-1",
        worker: "two words",
      }),
    },
    { reason: "invalid-adapter-reply", calls: sent },
  ],
  [
    "a reconciliation reply with a receipt that is not an identifier",
    {
      reconcile: resolved({
        kind: "accepted",
        receipt: "two words",
        worker: "worker-1",
      }),
    },
    { reason: "invalid-adapter-reply", calls: unsent },
  ],
  [
    "a delivery reply absent",
    { deliver: resolved(absent) },
    { reason: "invalid-adapter-reply", calls: sent },
  ],
  [
    "a delivery reply whose kind is the name of an inherited object property",
    { deliver: resolved(inherited("constructor")) },
    { reason: "invalid-adapter-reply", calls: sent },
  ],
  [
    "a reconciliation reply whose kind is the name of an inherited object property",
    { reconcile: resolved(inherited("toString")) },
    { reason: "invalid-adapter-reply", calls: unsent },
  ],
  [
    "a thrown delivery call",
    { deliver: () => Promise.reject(new Error("the reply is lost")) },
    { reason: "adapter-failure", calls: sent },
  ],
  [
    "a thrown reconciliation call",
    { reconcile: () => Promise.reject(new Error("no connection")) },
    { reason: "adapter-failure", calls: unsent },
  ],
] as const)
  await test(`CLV-049 ${name} is recorded as an unknown outcome with its reason, no send follows it, and the reconciliation attempts end at the recovery bound`, async () => {
    const started = await scene(script);
    assert.deepEqual(await bounded(started), [
      "outcome-unknown",
      3,
      1,
      ["unknown", expected.reason],
      3,
    ]);
    assert.deepEqual(started.calls, expected.calls);
    await started.authority.close();
  });

await test("CLV-049 a completed reply with a result above the result limit is recorded as completed with no stored result and the reason result-too-large", async () => {
  const large = "x".repeat(65);
  const started = await scene({
    deliver: resolved({
      kind: "completed",
      receipt: "receipt-1",
      worker: "worker-1",
      result: large,
    }),
  });
  assert.deepEqual(await closed(started), [
    "completed",
    "result-too-large",
    null,
    0,
    null,
    ["completed"],
    ["receipt-1", "worker-1"],
    ["receipt-1"],
  ]);
  assert.equal(
    await started.authority.queries.document(digestOf(large)),
    undefined,
  );
  await started.authority.close();
});

function slowFirstRun(slow: {
  readonly held: Promise<AdapterOutcome>;
  readonly signals: AbortSignal[];
}): Delivery {
  const adapter = scripted({});
  return {
    reconcile: adapter.delivery.reconcile,
    deliver: (intent, signal) => {
      if (intent.runId !== "run-1" || intent.kind !== "protected-effect")
        return adapter.delivery.deliver(intent, signal);
      slow.signals.push(signal);
      return slow.held;
    },
  };
}

await test("CLV-049 an adapter call above its time limit ends as an unknown outcome and does not hold the dispatch of a second run, its operation gets no new adapter call while that call is open, and its late success is ignored", async () => {
  const held = Promise.withResolvers<AdapterOutcome>();
  const signals: AbortSignal[] = [];
  const delivery = slowFirstRun({ held: held.promise, signals });
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery,
    clock: () => noon,
    timing: fastTiming,
    effects: { adapterMilliseconds: 80 },
  });
  const send = sender(authority, { now: noon });
  const requests = [];
  for (const runId of ["run-1", "run-2"]) {
    await runningRun(send, { effectLimit: 5, runId });
    const request = effectRequest({ commandId: `c-${runId}`, round: 1, runId });
    await send(request.command, request.documents);
    requests.push(request);
  }
  const [slow, quick] = requests.map((request) => request.operationId);
  assert.ok(slow !== undefined && quick !== undefined);
  const late: AdapterOutcome = {
    kind: "accepted",
    receipt: "late",
    worker: "worker-1",
  };
  try {
    await deliverUntil(
      authority,
      async () =>
        (await authority.effects.operation(quick))?.status === "running" &&
        (await authority.effects.operation(slow))?.status === "blocked",
    );
    const overdue = await authority.effects.operation(slow);
    assert.deepEqual(
      [overdue?.reason, overdue?.attempts, overdue?.receipt],
      ["outcome-unknown", 3, null],
    );
    assert.deepEqual(
      (await authority.events())
        .filter((event) => event.type === "operation.reconciled")
        .map((event) => [event.runId, event.payload["reason"]])
        .filter(([runId]) => runId === "run-1"),
      [
        ["run-1", "time-limit"],
        ["run-1", "time-limit"],
        ["run-1", "time-limit"],
      ],
    );
    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [true],
    );
    held.resolve(late);
    await deliverUntil(authority, () => Promise.resolve(true));
    assert.deepEqual(await authority.effects.operation(slow), overdue);
  } finally {
    held.resolve(late);
    await authority.close();
  }
});
