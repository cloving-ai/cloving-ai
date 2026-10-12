import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Delivery } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectReport,
  effectRequest,
  noon,
  runningRun,
  sender,
} from "./effect-fixture.ts";
import {
  drop,
  finalAt,
  quiet,
  runningEffects,
  scene,
  statuses,
  stopped,
  stopper,
  stops,
  type Reply,
  type Stopper,
} from "./effect-stop-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-049 a drop sends one stop request for each accepted, unsettled effect, and the run is cancelled only after the observed stop", async () => {
  const started = await scene(stopped);
  const { authority, adapter, send } = started;
  const [first, second, done] = await runningEffects(started, [1, 2, 3]);
  assert.ok(first !== undefined && second !== undefined && done !== undefined);
  const report = effectReport(done, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  await send(report.command, report.documents);
  assert.equal((await send(drop)).kind, "accepted");
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "stop-not-observed",
    unresolved: [],
    open: true,
  });
  await finalAt(authority, { request: second, status: "stopped" });
  await finalAt(authority, { request: first, status: "stopped" });
  await quiet(authority);
  assert.deepEqual([...stops(adapter.calls)].sort(), [
    "stop protected-effect 1",
    "stop protected-effect 2",
  ]);
  assert.deepEqual(await statuses(authority, [first, second, done]), [
    ["stopped", "receipt-1"],
    ["stopped", "receipt-2"],
    ["completed", "receipt-3"],
  ]);
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "cancelled",
    unresolved: [],
    open: false,
  });
  await authority.close();
});

await test("CLV-049 an effect that completes after a drop keeps its receipt and its result in the record", async () => {
  const completing: Reply = () =>
    Promise.resolve({
      kind: "completed",
      receipt: "receipt-1",
      worker: "worker-1",
      result: "the late result",
    });
  const started = await scene(completing);
  const { authority, send } = started;
  const [request] = await runningEffects(started, [1]);
  assert.ok(request);
  await send(drop);
  await finalAt(authority, { request, status: "completed" });
  const operation = await authority.effects.operation(request.operationId);
  assert.deepEqual(
    [operation?.receipt, operation?.worker, operation?.result === null],
    ["receipt-1", "worker-1", false],
  );
  assert.equal(
    await authority.queries.document(String(operation?.result)),
    "the late result",
  );
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

await test("CLV-049 a drop with a lost stop reply shows an uncertain stop, sends no new dispatch and claims no terminal cancellation", async () => {
  const lost: Reply = () => Promise.reject(new Error("the stop reply is lost"));
  const started = await scene(lost);
  const { authority, adapter, send } = started;
  const [request] = await runningEffects(started, [1]);
  assert.ok(request);
  const delivered = adapter.calls.filter((call) => call.startsWith("deliver"));
  await send(drop);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.closure("run-1")).closure === "stop-unconfirmed",
  );
  await quiet(authority);
  assert.equal(stops(adapter.calls).length, 3);
  assert.deepEqual(
    adapter.calls.filter((call) => call.startsWith("deliver")),
    delivered,
  );
  assert.deepEqual(await statuses(authority, [request]), [
    ["running", "receipt-1"],
  ]);
  assert.equal((await authority.state()).runs["run-1"]?.status, "cancelled");
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "stop-unconfirmed",
    unresolved: [],
    open: false,
  });
  await authority.close();
  const again = await scene(lost, started.directory);
  await quiet(again.authority);
  assert.equal(stops(again.adapter.calls).length, 1);
  await again.authority.close();
});

await test("CLV-049 a pause sends no stop request, and the present turn can settle", async () => {
  const started = await scene(stopped);
  const { authority, adapter, send } = started;
  const [request] = await runningEffects(started, [1]);
  assert.ok(request);
  const paused = await send({
    kind: "pause-run",
    commandId: "c-pause",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(paused.kind, "accepted");
  await quiet(authority);
  assert.deepEqual(stops(adapter.calls), []);
  const report = effectReport(request, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  const applied = await send(report.command, report.documents);
  assert.equal(Reflect.get(applied, "disposition"), "applied");
  assert.deepEqual(await statuses(authority, [request]), [
    ["completed", "receipt-1"],
  ]);
  await authority.close();
});

await test("CLV-049 a drop with no stop function in the adapter sends no stop request, and the run stays not cancelled until a worker report settles the effect", async () => {
  const started = await scene(undefined);
  const { authority, adapter, send } = started;
  const [request] = await runningEffects(started, [1]);
  assert.ok(request);
  await send(drop);
  await quiet(authority);
  assert.deepEqual(stops(adapter.calls), []);
  assert.equal(
    (await authority.effects.closure("run-1")).closure,
    "stop-not-observed",
  );
  const report = effectReport(request, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  await send(report.command, report.documents);
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

function heldDeliver(adapter: Stopper): {
  readonly delivery: Delivery;
  readonly entered: Promise<undefined>;
  readonly release: () => void;
} {
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  return {
    entered: entered.promise,
    release: () => {
      gate.resolve(undefined);
    },
    delivery: {
      ...adapter.delivery,
      deliver: async (intent, signal) => {
        if (intent.kind === "protected-effect") {
          entered.resolve(undefined);
          await gate.promise;
        }
        return adapter.delivery.deliver(intent, signal);
      },
    },
  };
}

await test("CLV-049 a cancellation in the adapter call of a send lets the effect start, and one stop request follows it", async () => {
  const adapter = stopper(stopped);
  const held = heldDeliver(adapter);
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: held.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 8 });
  const request = effectRequest({ commandId: "c-1", round: 1 });
  await send(request.command, request.documents);
  const settled = finalAt(authority, { request, status: "stopped" });
  await held.entered;
  assert.equal((await send(drop)).kind, "accepted");
  held.release();
  await settled;
  await quiet(authority);
  assert.deepEqual(stops(adapter.calls), ["stop protected-effect 1"]);
  assert.deepEqual(await statuses(authority, [request]), [
    ["stopped", "receipt-1"],
  ]);
  assert.deepEqual(
    (await authority.operations())
      .filter((record) => record.operationId === request.operationId)
      .flatMap((record) =>
        record.deliveries.map((item) => [item.purpose, item.outcome]),
      ),
    [
      ["dispatch", "accepted"],
      ["stop", "stopped"],
    ],
  );
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});

interface Uncertain {
  readonly delivery: Delivery;
  readonly reconciliations: string[];
  readonly hooks: { duringFirst: () => Promise<unknown> };
}

function uncertain(start: { readonly launched: boolean }): Uncertain {
  const reconciliations: string[] = [];
  const hooks = { duringFirst: (): Promise<unknown> => Promise.resolve() };
  let launched = start.launched;
  return {
    reconciliations,
    hooks,
    delivery: {
      deliver: (intent) => {
        if (intent.kind !== "protected-effect")
          return Promise.resolve({ receipt: "receipt-run" });
        launched = true;
        return Promise.reject(new Error("the reply is lost"));
      },
      reconcile: async (intent) => {
        if (intent.kind !== "protected-effect" || !launched)
          return { kind: "absent" };
        reconciliations.push(intent.purpose);
        if (reconciliations.length === 1) await hooks.duringFirst();
        return { kind: "unknown" };
      },
    },
  };
}

await test("CLV-049 a drop in the reconciliation of an effect with an unknown outcome gives reconciliation attempts up to the stop bound, and each opening gives one more attempt", async () => {
  const directory = await temporaryDirectory();
  const adapter = uncertain({ launched: false });
  const options = { clock: (): string => noon, timing: fastTiming };
  const authority = await openedAuthority(directory, {
    ...options,
    delivery: adapter.delivery,
  });
  const send = sender(authority, { now: noon });
  adapter.hooks.duringFirst = () => send(drop);
  await runningRun(send, { effectLimit: 8 });
  const request = effectRequest({ commandId: "c-1", round: 1 });
  await send(request.command, request.documents);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.closure("run-1")).closure === "stop-unconfirmed",
  );
  await quiet(authority);
  assert.deepEqual(adapter.reconciliations, [
    "reconcile",
    "reconcile",
    "reconcile",
    "reconcile",
  ]);
  assert.deepEqual(await statuses(authority, [request]), [["blocked", null]]);
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "stop-unconfirmed",
    unresolved: [request.operationId],
    open: false,
  });
  await authority.close();
  const next = uncertain({ launched: true });
  const again = await openedAuthority(directory, {
    ...options,
    delivery: next.delivery,
  });
  await quiet(again);
  assert.deepEqual(next.reconciliations, ["reconcile"]);
  await again.close();
});

await test("CLV-049 a rejected report of an operation of a dropped run at the stop bound starts one more stop attempt", async () => {
  const started = await scene(() =>
    Promise.reject(new Error("the stop reply is lost")),
  );
  const { authority, adapter, send } = started;
  const [request] = await runningEffects(started, [1]);
  assert.ok(request);
  await send(drop);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.closure("run-1")).closure === "stop-unconfirmed",
  );
  await quiet(authority);
  assert.equal(stops(adapter.calls).length, 3);
  const report = effectReport(request, {
    commandId: "c-late",
    leaseGeneration: 1,
    worker: "worker-9",
    result: "the result",
  });
  const receipt = await send(report.command, report.documents);
  assert.equal(Reflect.get(receipt, "disposition"), "rejected");
  await quiet(authority);
  assert.equal(stops(adapter.calls).length, 4);
  assert.equal(
    (await authority.effects.closure("run-1")).closure,
    "stop-unconfirmed",
  );
  await authority.close();
});
