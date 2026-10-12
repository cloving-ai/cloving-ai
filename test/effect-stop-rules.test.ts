import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
} from "../src/broker/actor/authority.ts";
import { deliveryHandler } from "../src/broker/actor/authority-delivery.ts";
import { ownedDatabase } from "../src/broker/actor/authority-runtime.ts";
import { effectSettings } from "../src/broker/actor/authority-settings.ts";
import {
  deliverUntil,
  executePinned,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  pin,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectReport,
  effectRequest,
  leaseExpiry,
  noon,
  runningRun,
  sender,
  type Request,
  type Send,
} from "./effect-fixture.ts";
import {
  drop,
  quiet,
  runningEffects,
  scene,
  statuses,
  stopped,
  stopper,
  stops,
} from "./effect-stop-fixture.ts";

after(removeTemporaryDirectories);

const afterExpiry = "2026-10-10T12:30:00.000Z";

async function rows(authority: Authority): Promise<readonly unknown[]> {
  return (await authority.operations()).map((record) =>
    record.deliveries.map((item) => [item.purpose, item.outcome]),
  );
}

interface Recording {
  readonly delivery: Delivery;
  readonly calls: string[];
}

const acceptance: AdapterOutcome = {
  kind: "accepted",
  receipt: "receipt-1",
  worker: "worker-1",
};

function recording(reconciled: AdapterOutcome): Recording {
  const calls: string[] = [];
  return {
    calls,
    delivery: {
      deliver: (intent) => {
        calls.push(`deliver ${intent.kind}`);
        return Promise.resolve(acceptance);
      },
      reconcile: (intent) => {
        calls.push(`reconcile ${intent.kind} ${intent.purpose}`);
        return Promise.resolve(
          intent.purpose === "reconcile" ? reconciled : { kind: "absent" },
        );
      },
      stop: (intent) => {
        calls.push(`stop ${intent.kind}`);
        return Promise.resolve({ kind: "stopped" });
      },
    },
  };
}

const unknownRows = [
  ["dispatch", "accepted"],
  ["reconcile", "unknown"],
  ["reconcile", "unknown"],
  ["reconcile", "unknown"],
];

const options = (clock: { now: string }) => ({
  clock: (): string => clock.now,
  timing: fastTiming,
});

interface Ended {
  readonly authority: Authority;
  readonly first: Recording;
  readonly directory: string;
  readonly clock: { now: string };
  readonly send: Send;
  readonly request: Request;
}

async function endedRun(ending: string): Promise<Ended> {
  const directory = await temporaryDirectory();
  const first = recording({ kind: "unknown" });
  const clock = { now: noon };
  const authority = await openedAuthority(directory, {
    ...options(clock),
    delivery: first.delivery,
  });
  const send = sender(authority, clock);
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-1", round: 1 });
  await send(request.command, request.documents);
  await quiet(authority);
  const ended = await send({
    kind: ending,
    commandId: "c-end",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(ended.kind, "accepted");
  return { authority, first, directory, clock, send, request };
}

const completion: AdapterOutcome = {
  kind: "completed",
  receipt: "receipt-1",
  worker: "worker-1",
  result: "the result",
};

for (const ending of ["complete-run", "fail-run"])
  await test(`CLV-049 an accepted operation of a run that ended with ${ending} gets no stop request, also after a late drop, a reconciliation after its lease expiry and one more at the next opening`, async () => {
    const { authority, first, directory, clock, send, request } =
      await endedRun(ending);
    const late = await send({ ...drop, expectedRevision: 3 });
    assert.deepEqual(
      [late.kind, Reflect.get(late, "reason")],
      ["rejected", "terminal-run"],
    );
    await quiet(authority);
    assert.deepEqual(await rows(authority), [
      [["dispatch", "withheld"]],
      [["dispatch", "accepted"]],
    ]);
    clock.now = afterExpiry;
    await send({ ...leaseExpiry(request, 1) });
    await quiet(authority);
    assert.deepEqual(await rows(authority), [
      [["dispatch", "withheld"]],
      unknownRows,
    ]);
    assert.equal(
      (await authority.effects.operation(request.operationId))?.status,
      "blocked",
    );
    await authority.close();
    const second = recording(completion);
    const again = await openedAuthority(directory, {
      ...options(clock),
      delivery: second.delivery,
    });
    await quiet(again);
    assert.deepEqual(await statuses(again, [request]), [
      ["completed", "receipt-1"],
    ]);
    assert.deepEqual(await rows(again), [
      [["dispatch", "withheld"]],
      [...unknownRows, ["reconcile", "completed"]],
    ]);
    assert.deepEqual(stops([...first.calls, ...second.calls]), []);
    await again.close();
  });

await test("CLV-049 a stop attempt for an operation that a report settled before the handler ran makes no stop call, and the run is not cancelled while that attempt is open", async () => {
  const started = await scene(stopped);
  const { authority, adapter, send } = started;
  const [request] = await runningEffects(started, [1]);
  assert.ok(request);
  assert.equal((await send(drop)).kind, "accepted");
  const report = effectReport(request, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  const applied = await send(report.command, report.documents);
  assert.equal(Reflect.get(applied, "disposition"), "applied");
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "stop-not-observed",
    unresolved: [],
    open: true,
  });
  await quiet(authority);
  assert.deepEqual(stops(adapter.calls), []);
  assert.deepEqual(await rows(authority), [
    [["dispatch", "withheld"]],
    [
      ["dispatch", "accepted"],
      ["stop", "withheld"],
    ],
  ]);
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

const start = storedGate[0] ?? {};

const bounded = {
  clock: (): string => noon,
  timing: fastTiming,
  effects: { deliveryAttempts: 1, stopLimit: 1 },
};

function unreceipted(dropped: { now: boolean }): Recording {
  const calls: string[] = [];
  return {
    calls,
    delivery: {
      deliver: () => Promise.reject(new Error("no send expected")),
      reconcile: (intent) => {
        calls.push(`reconcile ${intent.purpose}`);
        return dropped.now
          ? Promise.resolve({ kind: "accepted", receipt: "two words" })
          : Promise.reject(new Error("destination unreachable"));
      },
    },
  };
}

await test("CLV-049 a reconciliation reply accepted with no valid receipt for a start of a dropped run is an unknown outcome and records no dispatch", async () => {
  const dropped = { now: false };
  const adapter = unreceipted(dropped);
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...bounded,
    delivery: adapter.delivery,
  });
  await executePinned(authority, start);
  await quiet(authority);
  dropped.now = true;
  await authority.execute(
    { ...drop, expectedRevision: 1 },
    { recordedAt: noon },
  );
  await quiet(authority);
  assert.deepEqual(await rows(authority), [
    [
      ["dispatch", "failed"],
      ["reconcile", "unknown"],
    ],
  ]);
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "stop-unconfirmed",
    unresolved: [
      '["cloving-operation",0,"run-1","admission","start-run",null,null]',
    ],
    open: false,
  });
  await authority.close();
});

for (const [name, reply] of [
  ["absent", { kind: "absent" }],
  ["accepted", { kind: "accepted", receipt: "receipt-9", worker: "worker-1" }],
] as const)
  await test(`CLV-049 after a stop reply ${name} for a sent start of a dropped run, the handler reconciles the start and records the reply of the reconciliation`, async () => {
    const adapter = stopper(() => Promise.resolve(reply));
    const authority = await openedAuthority(await temporaryDirectory(), {
      ...bounded,
      delivery: adapter.delivery,
    });
    await executePinned(authority, start);
    await deliverUntil(
      authority,
      async () => (await authority.eligibleIntents()).length === 0,
    );
    const before = adapter.calls.length;
    await authority.execute(
      { ...drop, expectedRevision: 1 },
      { recordedAt: noon },
    );
    await quiet(authority);
    assert.deepEqual(adapter.calls.slice(before), [
      "stop start-run 0",
      "reconcile start-run 0",
    ]);
    assert.deepEqual(await rows(authority), [
      [
        ["dispatch", "sent"],
        ["stop", "sent"],
      ],
    ]);
    await authority.close();
  });

await test("CLV-049 a dropped run whose start has a worker stop report is not cancelled while the stop attempt of that start is open, and no second stop request follows a stop reply that is no confirmation", async () => {
  const started = await scene(() => Promise.resolve({ kind: "unknown" }));
  const { authority, adapter } = started;
  await executePinned(authority, start);
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  await authority.execute(
    { ...drop, expectedRevision: 1 },
    { recordedAt: noon },
  );
  await authority.execute(
    {
      kind: "report-observation",
      commandId: "c-stopped",
      runId: "run-1",
      condition: "stopped",
      reason: "worker-exit",
      operationId:
        '["cloving-operation",0,"run-1","admission","start-run",null,null]',
    },
    { recordedAt: noon },
  );
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "stop-not-observed",
    unresolved: [],
    open: true,
  });
  await quiet(authority);
  assert.deepEqual(stops(adapter.calls), ["stop start-run 0"]);
  assert.deepEqual(await rows(authority), [
    [
      ["dispatch", "sent"],
      ["stop", "sent"],
    ],
  ]);
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

await test("CLV-049 a second handler invocation for a closed stop attempt of a start makes no adapter call", async () => {
  const started = await scene(stopped);
  await executePinned(started.authority, start);
  await deliverUntil(
    started.authority,
    async () => (await started.authority.eligibleIntents()).length === 0,
  );
  await started.authority.execute(
    { ...drop, expectedRevision: 1 },
    { recordedAt: noon },
  );
  await deliverUntil(
    started.authority,
    async () =>
      (await started.authority.effects.closure("run-1")).closure ===
      "cancelled",
  );
  await started.authority.close();
  const [attempt] = queryDatabase(
    started.directory,
    "SELECT d.effect_id, d.operation_id, d.input_digest FROM deliveries d JOIN dispatch_attempts a ON a.effect_id = d.effect_id WHERE a.purpose = 'stop'",
  );
  const owned = await ownedDatabase(started.directory);
  assert.equal(owned.kind, "owned");
  const second = stopper(stopped);
  const handler = deliveryHandler({
    reader: owned.database,
    delivery: second.delivery,
    epoch: () => 2,
    clock: () => noon,
    effects: effectSettings,
    available: undefined,
  });
  const result = await handler(
    {
      kind: "start-run",
      runId: "run-1",
      operationId: String(Reflect.get(Object(attempt), "operation_id")),
      workflow: pin,
      inputDigest: String(Reflect.get(Object(attempt), "input_digest")),
      purpose: "stop",
    },
    {
      id: String(Reflect.get(Object(attempt), "effect_id")),
      attempt: 2,
      sourceMessageId: "message-1",
      actorType: "ClovingAuthority",
      actorId: "a",
    },
  );
  await owned.database.close();
  assert.equal(result["kind"], "withheld");
  assert.deepEqual(second.calls, []);
});
