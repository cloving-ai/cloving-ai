import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import { deliverUntil, openedAuthority } from "./authority-actor-fixture.ts";
import { removeTemporaryDirectories } from "./authority-store-fixture.ts";
import {
  effectReport,
  effectRequest,
  leaseExpiry,
  runningRun,
  type Request,
} from "./effect-fixture.ts";
import { droppedWithNoStop, quiet, stopper } from "./effect-stop-fixture.ts";

after(removeTemporaryDirectories);

const afterExpiry = "2026-10-10T12:30:00.000Z";

async function attempts(
  authority: Authority,
  request: Request,
): Promise<readonly unknown[]> {
  return (await authority.operations())
    .filter((record) => record.operationId === request.operationId)
    .flatMap((record) =>
      record.deliveries.map((item) => [item.purpose, item.outcome]),
    );
}

const unchanged = (delivery: Delivery): Delivery => delivery;

const accepted = ["reconcile", "accepted"];

await test("CLV-049 with no stop function, an accepted effect of a dropped run is reconciled after its lease expiry up to the stop limit, and the closure then shows an unconfirmed stop", async () => {
  const dropped = await droppedWithNoStop(unchanged);
  const { authority, send, clock, request, directory, options } = dropped;
  assert.deepEqual(await attempts(authority, request), [
    ["dispatch", "accepted"],
  ]);
  assert.equal(
    (await authority.effects.closure("run-1")).closure,
    "stop-not-observed",
  );
  clock.now = afterExpiry;
  assert.equal((await send({ ...leaseExpiry(request, 1) })).kind, "accepted");
  await quiet(authority);
  assert.deepEqual(await attempts(authority, request), [
    ["dispatch", "accepted"],
    accepted,
    accepted,
    accepted,
  ]);
  const expired = await authority.effects.operation(request.operationId);
  assert.deepEqual(
    [expired?.status, expired?.receipt],
    ["recovering", "receipt-1"],
  );
  assert.deepEqual(await authority.effects.closure("run-1"), {
    closure: "stop-unconfirmed",
    unresolved: [],
    open: false,
  });
  const report = effectReport(request, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  const late = await send(report.command, report.documents);
  assert.equal(Reflect.get(late, "disposition"), "rejected");
  await quiet(authority);
  assert.equal((await attempts(authority, request)).length, 5);
  await authority.close();
  const next = stopper(undefined);
  next.accepted.add(request.operationId);
  const again = await openedAuthority(directory, {
    ...options,
    delivery: next.delivery,
  });
  await quiet(again);
  assert.deepEqual(next.calls, ["reconcile protected-effect 1"]);
  assert.equal((await attempts(again, request)).length, 6);
  assert.equal(
    (await again.effects.closure("run-1")).closure,
    "stop-unconfirmed",
  );
  await again.close();
});

const completion: AdapterOutcome = {
  kind: "completed",
  receipt: "receipt-1",
  worker: "worker-1",
  result: "the result of the worker",
};

function effectOf(intent: DeliveryIntent): boolean {
  return intent.kind === "protected-effect" && intent.runId === "run-1";
}

function completing(switched: {
  on: boolean;
}): (delivery: Delivery) => Delivery {
  return (delivery: Delivery): Delivery => ({
    ...delivery,
    reconcile: (intent, signal) =>
      switched.on && effectOf(intent)
        ? Promise.resolve(completion)
        : delivery.reconcile(intent, signal),
  });
}

await test("CLV-049 with no stop function, a reconciliation after the lease expiry that finds the completed effect of a dropped run settles it, and the next run gets the freed capacity unit", async () => {
  const switched = { on: false };
  const dropped = await droppedWithNoStop(completing(switched));
  const { authority, send, clock, request } = dropped;
  await runningRun(send, { effectLimit: 8, runId: "run-2" });
  const second = effectRequest({
    commandId: "c-2",
    round: 1,
    runId: "run-2",
  });
  await send(second.command, second.documents);
  await quiet(authority);
  assert.equal(
    (await authority.effects.operation(second.operationId))?.status,
    "waiting",
  );
  switched.on = true;
  clock.now = afterExpiry;
  assert.equal((await send({ ...leaseExpiry(request, 1) })).kind, "accepted");
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(second.operationId))?.status ===
      "running",
  );
  const settled = await authority.effects.operation(request.operationId);
  assert.deepEqual(
    [settled?.status, settled?.receipt, settled?.leaseGeneration],
    ["completed", "receipt-1", null],
  );
  assert.deepEqual(await attempts(authority, request), [
    ["dispatch", "accepted"],
    ["reconcile", "completed"],
  ]);
  assert.equal((await authority.effects.closure("run-1")).closure, "cancelled");
  await authority.close();
});
