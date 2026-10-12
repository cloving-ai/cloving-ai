import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectReport,
  effectRequest,
  noon,
  runningRun,
  sender,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

interface Recorder {
  readonly delivery: Delivery;
  readonly calls: string[];
  readonly sent: DeliveryIntent[];
}

type Reply = (call: number) => Promise<AdapterOutcome>;

function recorder(script: {
  readonly reconcile: Reply;
  readonly deliver: Reply;
}): Recorder {
  const calls: string[] = [];
  const sent: DeliveryIntent[] = [];
  const counted = (name: "reconcile" | "deliver"): number =>
    calls.filter((call) => call.startsWith(name)).length;
  return {
    calls,
    sent,
    delivery: {
      reconcile: (intent) => {
        if (intent.kind !== "protected-effect")
          return Promise.resolve({ kind: "absent" });
        calls.push(`reconcile ${intent.purpose}`);
        return script.reconcile(counted("reconcile"));
      },
      deliver: (intent) => {
        if (intent.kind !== "protected-effect")
          return Promise.resolve({ kind: "accepted", receipt: "receipt-run" });
        calls.push(`deliver ${intent.purpose}`);
        sent.push(intent);
        return script.deliver(counted("deliver"));
      },
    },
  };
}

const absent: AdapterOutcome = { kind: "absent" };
const unknown: AdapterOutcome = { kind: "unknown" };
const accepted: AdapterOutcome = {
  kind: "accepted",
  receipt: "receipt-1",
  worker: "worker-1",
};
const completed: AdapterOutcome = {
  kind: "completed",
  receipt: "receipt-1",
  worker: "worker-1",
  result: "the result",
};
const lost = (): Promise<AdapterOutcome> =>
  Promise.reject(new Error("the reply is lost"));

const request = effectRequest({ commandId: "c-request", round: 1 });
const { operationId } = request;

async function opened(
  directory: string,
  adapter: Recorder,
): Promise<Authority> {
  return openedAuthority(directory, {
    delivery: adapter.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
}

async function requested(authority: Authority): Promise<void> {
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const receipt = await send(request.command, request.documents);
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
}

async function attempts(authority: Authority): Promise<readonly unknown[]> {
  return (await authority.operations())
    .filter((record) => record.operationId === operationId)
    .flatMap((record) =>
      record.deliveries.map((item) => [item.purpose, item.outcome]),
    );
}

function until(authority: Authority, status: string): Promise<void> {
  return deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === status,
  );
}

async function quiet(authority: Authority): Promise<void> {
  let rounds = 0;
  await deliverUntil(authority, () => {
    rounds += 1;
    return Promise.resolve(rounds > 20);
  });
}

async function reached(condition: () => boolean): Promise<void> {
  for (let attempt = 0; !condition(); attempt += 1) {
    assert.ok(attempt < 300, "the condition was not reached");
    await delay(10);
  }
}

await test("CLV-049 an operation with no outcome after reconciliation enters a recovery state with a bound, and the service does not send it again", async () => {
  const held = Promise.withResolvers<AdapterOutcome>();
  const adapter = recorder({
    reconcile: (call) =>
      [Promise.resolve(absent), held.promise][call - 1] ??
      Promise.resolve(unknown),
    deliver: lost,
  });
  const authority = await opened(await temporaryDirectory(), adapter);
  await requested(authority);
  const blocked = until(authority, "blocked");
  try {
    await reached(() => adapter.calls.length === 3);
    const recovering = await authority.effects.operation(operationId);
    assert.deepEqual(
      [recovering?.status, recovering?.reason, recovering?.attempts],
      ["recovering", "outcome-unknown", 1],
    );
  } finally {
    held.resolve(unknown);
    await blocked.catch(() => undefined);
  }
  assert.deepEqual(adapter.calls, [
    "reconcile dispatch",
    "deliver dispatch",
    "reconcile reconcile",
    "reconcile reconcile",
  ]);
  assert.equal(
    (await authority.effects.operation(operationId))?.status,
    "blocked",
  );
  await authority.close();
});

await test("CLV-049 after the recovery bound, the operation has a blocked state with evidence and gets no new attempt in that opening, and the next opening reconciles it one time", async () => {
  const directory = await temporaryDirectory();
  const adapter = recorder({
    reconcile: (call) => Promise.resolve(call === 1 ? absent : unknown),
    deliver: lost,
  });
  const first = await opened(directory, adapter);
  await requested(first);
  await until(first, "blocked");
  await quiet(first);
  const operation = await first.effects.operation(operationId);
  assert.deepEqual(
    [
      operation?.status,
      operation?.reason,
      operation?.attempts,
      operation?.recoveryLimit,
      operation?.leaseGeneration,
    ],
    ["blocked", "outcome-unknown", 3, 3, 1],
  );
  assert.deepEqual(await attempts(first), [
    ["dispatch", "unknown"],
    ["reconcile", "unknown"],
    ["reconcile", "unknown"],
  ]);
  const evidence = [];
  for (const event of await first.events())
    if (event.type === "operation.reconciled")
      evidence.push([
        event.payload["outcome"],
        (await first.effects.disposition(event.sequence))?.disposition,
      ]);
  assert.deepEqual(evidence, [
    ["unknown", "applied"],
    ["unknown", "applied"],
    ["unknown", "applied"],
  ]);
  await first.close();
  const found = recorder({
    reconcile: () => Promise.resolve(accepted),
    deliver: lost,
  });
  const second = await opened(directory, found);
  await until(second, "running");
  assert.deepEqual(found.calls, ["reconcile reconcile"]);
  assert.deepEqual((await attempts(second)).at(-1), ["reconcile", "accepted"]);
  await second.close();
});

await test("CLV-049 an unknown outcome of an effect that is not idempotent blocks a second send: the next send needs a reconciliation that finds no effect, and it uses the next lease generation", async () => {
  const adapter = recorder({
    reconcile: () => Promise.resolve(absent),
    deliver: (call) => (call === 1 ? lost() : Promise.resolve(accepted)),
  });
  const authority = await opened(await temporaryDirectory(), adapter);
  await requested(authority);
  await until(authority, "running");
  assert.deepEqual(adapter.calls, [
    "reconcile dispatch",
    "deliver dispatch",
    "reconcile reconcile",
    "reconcile dispatch",
    "deliver dispatch",
  ]);
  assert.deepEqual(
    adapter.sent.map((intent) => intent.leaseGeneration),
    [1, 2],
  );
  assert.deepEqual(await attempts(authority), [
    ["dispatch", "unknown"],
    ["reconcile", "absent"],
    ["dispatch", "accepted"],
  ]);
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.attempts, operation?.leaseGeneration, operation?.receipt],
    [1, 2, "receipt-1"],
  );
  await authority.close();
});

const start = storedGate[0] ?? {};

function failingStarts(
  failures: number,
): Recorder & { readonly count: () => number } {
  let delivered = 0;
  const calls: string[] = [];
  const sent: DeliveryIntent[] = [];
  return {
    calls,
    sent,
    count: () => delivered,
    delivery: {
      reconcile: () => {
        calls.push("reconcile");
        return Promise.resolve({ kind: "absent" });
      },
      deliver: (intent) => {
        calls.push("deliver");
        delivered += 1;
        if (delivered <= failures)
          return Promise.reject(new Error("transient adapter failure"));
        sent.push(intent);
        return Promise.resolve({ receipt: `receipt-${String(delivered)}` });
      },
    },
  };
}

async function startOutcomes(
  authority: Authority,
): Promise<readonly unknown[]> {
  return (await authority.operations()).flatMap((record) =>
    record.deliveries.map((item) => item.outcome),
  );
}

await test("CLV-049 a failed delivery of a start is tried again in the same opening, with a reconciliation first", async () => {
  const adapter = failingStarts(1);
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter.delivery,
    timing: fastTiming,
  });
  assert.equal((await executePinned(authority, start)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await startOutcomes(authority), ["failed", "sent"]);
  assert.deepEqual(adapter.calls, [
    "reconcile",
    "deliver",
    "reconcile",
    "deliver",
  ]);
  await authority.close();
});

await test("CLV-049 a delivery of a start that fails again is not tried a third time in the same opening, and the next opening tries it again", async () => {
  const directory = await temporaryDirectory();
  const adapter = failingStarts(2);
  const first = await openedAuthority(directory, {
    delivery: adapter.delivery,
    timing: fastTiming,
  });
  assert.equal((await executePinned(first, start)).kind, "accepted");
  await deliverUntil(first, () => Promise.resolve(adapter.count() === 2));
  let rounds = 0;
  await deliverUntil(first, () => {
    rounds += 1;
    return Promise.resolve(rounds > 20);
  });
  assert.deepEqual(await startOutcomes(first), ["failed", "failed"]);
  assert.equal(adapter.count(), 2);
  await first.close();
  const second = await openedAuthority(directory, {
    delivery: adapter.delivery,
    timing: fastTiming,
  });
  await deliverUntil(
    second,
    async () => (await second.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await startOutcomes(second), ["failed", "failed", "sent"]);
  await second.close();
});

await test("CLV-049 with one delivery attempt in the settings, a failed delivery of a start is not tried again in the same opening", async () => {
  const adapter = failingStarts(1);
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: adapter.delivery,
    timing: fastTiming,
    effects: { deliveryAttempts: 1 },
  });
  assert.equal((await executePinned(authority, start)).kind, "accepted");
  await deliverUntil(authority, () => Promise.resolve(adapter.count() === 1));
  let rounds = 0;
  await deliverUntil(authority, () => {
    rounds += 1;
    return Promise.resolve(rounds > 20);
  });
  assert.deepEqual(await startOutcomes(authority), ["failed"]);
  await authority.close();
});

await test("CLV-049 a rejected report of a blocked operation starts one reconciliation, and a reconciliation that finds the result settles the operation", async () => {
  const adapter = recorder({
    reconcile: (call) =>
      Promise.resolve([absent, unknown, unknown][call - 1] ?? completed),
    deliver: lost,
  });
  const authority = await opened(await temporaryDirectory(), adapter);
  await requested(authority);
  await until(authority, "blocked");
  await quiet(authority);
  assert.equal(adapter.calls.length, 4);
  const report = effectReport(request, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  const rejected = await sender(authority, { now: noon })(
    report.command,
    report.documents,
  );
  assert.equal(Reflect.get(rejected, "disposition"), "rejected");
  await until(authority, "completed");
  assert.deepEqual(adapter.calls.slice(4), ["reconcile reconcile"]);
  assert.deepEqual((await attempts(authority)).at(-1), [
    "reconcile",
    "completed",
  ]);
  await authority.close();
});
