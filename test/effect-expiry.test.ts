import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  openAuthority,
  type Authority,
} from "../src/broker/actor/authority.ts";
import { expiryScan } from "../src/service/expiry.ts";
import { commandGateway } from "../src/service/gateway.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectReport,
  effectRequest,
  fakeDestination,
  later,
  leaseExpiry,
  noon,
  runningRun,
  sender,
  type Destination,
  type Request,
  type Send,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

interface Clock {
  now: string;
}

interface Scene {
  readonly authority: Authority;
  readonly destination: Destination;
  readonly clock: Clock;
  readonly send: Send;
}

async function scene(): Promise<Scene> {
  const destination = fakeDestination();
  const clock = { now: noon };
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: destination.delivery,
    clock: () => clock.now,
    timing: fastTiming,
  });
  const send = sender(authority, clock);
  await runningRun(send, { effectLimit: 5 });
  return { authority, destination, clock, send };
}

async function running(started: Scene, request: Request): Promise<void> {
  await started.send(request.command, request.documents);
  await deliverUntil(
    started.authority,
    async () =>
      (await started.authority.effects.operation(request.operationId))
        ?.status === "running",
  );
}

async function view(
  authority: Authority,
  request: Request,
): Promise<readonly unknown[]> {
  const operation = await authority.effects.operation(request.operationId);
  return [operation?.status, operation?.reason, operation?.leaseGeneration];
}

function field(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

const held = effectRequest({
  commandId: "c-1",
  round: 1,
  resource: "repository",
});
const waiting = effectRequest({
  commandId: "c-2",
  round: 2,
  resource: "repository",
});

await test("CLV-049 an expired lease alone starts no replacement send", async () => {
  const started = await scene();
  const { authority, destination, clock, send } = started;
  await running(started, held);
  await send(waiting.command, waiting.documents);
  clock.now = later;
  const expired = await authority.execute(leaseExpiry(held, 1), {
    recordedAt: later,
  });
  assert.equal(expired.kind, "accepted", JSON.stringify(expired));
  await deliverUntil(authority, async () =>
    (await authority.operations()).some((record) =>
      record.deliveries.some(
        (item) => item.purpose === "reconcile" && item.outcome === "accepted",
      ),
    ),
  );
  assert.deepEqual(await view(authority, held), [
    "recovering",
    "lease-expired",
    1,
  ]);
  assert.deepEqual(await view(authority, waiting), [
    "waiting",
    "resource",
    null,
  ]);
  assert.deepEqual(destination.effects, [held.operationId]);
  assert.equal(
    destination.calls.filter((call) => call.startsWith("deliver")).length,
    1,
  );
  assert.deepEqual(
    (await authority.events()).map((event) => event.type).slice(-2),
    ["lease.expired", "operation.reconciled"],
  );
  await authority.close();
});

await test("CLV-049 EV-10: after the expiry of a lease the authority rejects the late result and a new protected request of that generation, and the fake destination has one dispatch", async () => {
  const started = await scene();
  const { authority, destination, clock, send } = started;
  await running(started, held);
  clock.now = later;
  await authority.execute(leaseExpiry(held, 1), { recordedAt: later });
  const late = effectReport(held, {
    commandId: "c-late",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the late result",
  });
  const rejected = await send(late.command, late.documents);
  const child = effectRequest({ commandId: "c-child", round: 3 });
  const denied = await send(
    { ...child.command, source: held.operationId, sourceGeneration: 1 },
    child.documents,
  );
  const stored = [];
  for (const receipt of [rejected, denied])
    stored.push(
      await authority.effects.disposition(Number(field(receipt, "sequence"))),
    );
  assert.deepEqual(
    stored.map((item) => [item?.disposition, item?.reason]),
    [
      ["rejected", "lease-expired"],
      ["denied", "lease-expired"],
    ],
  );
  assert.equal(await authority.effects.operation(child.operationId), undefined);
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.deepEqual(destination.effects, [held.operationId]);
  assert.equal(
    destination.calls.filter((call) => call.startsWith("deliver")).length,
    1,
  );
  await authority.close();
});

await test("CLV-049 the authority denies a protected request from a retired generation", async () => {
  const started = await scene();
  const { authority, send } = started;
  await running(started, held);
  const done = effectReport(held, {
    commandId: "c-done",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  await send(done.command, done.documents);
  const child = effectRequest({ commandId: "c-child", round: 3 });
  const receipt = await send(
    { ...child.command, source: held.operationId, sourceGeneration: 1 },
    child.documents,
  );
  assert.deepEqual(
    [receipt.kind, field(receipt, "disposition"), field(receipt, "intents")],
    ["accepted", "denied", []],
  );
  assert.deepEqual(
    await authority.effects.disposition(Number(field(receipt, "sequence"))),
    {
      runId: "run-1",
      operationId: child.operationId,
      disposition: "denied",
      reason: "retired-lease-generation",
    },
  );
  assert.equal(await authority.effects.operation(child.operationId), undefined);
  assert.equal((await authority.effects.budget("run-1"))?.spent, 1);
  await authority.close();
});

await test("CLV-049 a lease expiry has a fixed command ID: a second expiry is a duplicate, an expiry before its time commits nothing, and a different command ID form is refused", async () => {
  const started = await scene();
  const { authority } = started;
  await running(started, held);
  const command = leaseExpiry(held, 1);
  const events = (await authority.events()).length;
  assert.deepEqual(await authority.execute(command, { recordedAt: noon }), {
    kind: "rejected",
    reason: "lease-not-expired",
  });
  for (const forged of [
    { ...command, commandId: "c-expire" },
    { ...command, commandId: `${command.commandId}0` },
    { ...held.command, commandId: command.commandId },
  ])
    assert.deepEqual(
      await authority.execute(forged, {
        recordedAt: later,
        epoch: authority.epoch,
        documents: held.documents,
      }),
      { kind: "rejected", reason: "delivery-owned-command" },
      JSON.stringify(forged),
    );
  assert.equal((await authority.events()).length, events);
  const first = await authority.execute(command, { recordedAt: later });
  const second = await authority.execute(command, { recordedAt: later });
  assert.deepEqual(
    [first.kind, second.kind, field(second, "sequence")],
    ["accepted", "duplicate", field(first, "sequence")],
  );
  await authority.close();
});

await test("CLV-049 the lease scan sends one expiry for each lease that is due, and a lease before its expiry gets none", async () => {
  const started = await scene();
  const { authority, clock } = started;
  await running(started, held);
  assert.deepEqual(await authority.effects.dueLeases(noon), []);
  assert.deepEqual(await authority.effects.dueLeases(later), [
    { runId: "run-1", operationId: held.operationId, generation: 1 },
  ]);
  const scan = expiryScan({
    authority,
    gateway: commandGateway({
      authority,
      registry: workflowRegistry([]),
      clock: () => clock.now,
      textBytes: 1000,
    }),
    clock: () => clock.now,
    intervalMilliseconds: 5,
  });
  await delay(60);
  assert.equal(
    (await authority.events()).filter((event) => event.type === "lease.expired")
      .length,
    0,
  );
  clock.now = later;
  await delay(120);
  await scan.stop();
  assert.equal(
    (await authority.events()).filter((event) => event.type === "lease.expired")
      .length,
    1,
  );
  assert.deepEqual(await authority.effects.dueLeases(later), []);
  await authority.close();
});

await test("CLV-049 a callback of an earlier epoch for a protected effect is recorded as an unknown outcome, and a reconciliation records the original receipt with no second send", async () => {
  const directory = await temporaryDirectory();
  const destination = fakeDestination();
  const options = {
    delivery: destination.delivery,
    clock: (): string => noon,
    timing: fastTiming,
  };
  const first = await openedAuthority(directory, options);
  await runningRun(sender(first, { now: noon }), { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  await sender(first, { now: noon })(request.command, request.documents);
  await first.close();
  alterDatabase(
    directory,
    "CREATE TRIGGER inject BEFORE UPDATE ON deliveries WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'injected-callback-failure'); END;",
  );
  const failing = await openedAuthority(directory, options);
  const controller = new AbortController();
  const failure = await Promise.race([
    failing.deliver(controller.signal).then(
      () => "stopped",
      (error: unknown) => String(error),
    ),
    delay(5_000, "not detected", { ref: false }),
  ]);
  controller.abort();
  assert.match(failure, /dead-lettered message .*injected-callback-failure/);
  await failing.close();
  const refused = await openAuthority(directory, options);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.reason, "unresolved-delivery");
  alterDatabase(directory, "DROP TRIGGER inject");
  const repaired = await openedAuthority(directory, options);
  await deliverUntil(
    repaired,
    async () =>
      (await repaired.effects.operation(request.operationId))?.status ===
      "running",
  );
  const operation = await repaired.effects.operation(request.operationId);
  assert.deepEqual([operation?.receipt, operation?.attempts], ["receipt-1", 1]);
  assert.deepEqual(
    (await repaired.operations())
      .filter((record) => record.operationId === request.operationId)
      .flatMap((record) =>
        record.deliveries.map((item) => [item.purpose, item.outcome]),
      ),
    [
      ["dispatch", "stale-epoch"],
      ["reconcile", "accepted"],
    ],
  );
  assert.equal(
    destination.calls.filter((call) => call.startsWith("deliver")).length,
    1,
  );
  await repaired.close();
});
