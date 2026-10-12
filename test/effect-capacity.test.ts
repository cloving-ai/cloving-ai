import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Delivery } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  queryDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  completed,
  reopened,
  requestOf,
  scene,
  settled,
  statuses,
} from "./effect-capacity-fixture.ts";
import {
  fakeDestination,
  noon,
  runningRun,
  sender,
  type Destination,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-049 with N effects in flight at the bound N, the next effect waits, and a restart keeps the wait and its reason", async () => {
  const first = await scene(2, ["run-1", "run-2"]);
  const requests = [
    requestOf("run-1", { round: 1 }),
    requestOf("run-2", { round: 1 }),
    requestOf("run-1", { round: 2 }),
  ];
  for (const request of requests)
    await first.send(request.command, request.documents);
  await settled(first.authority);
  const expected = [
    ["running", null, 1],
    ["running", null, 1],
    ["waiting", "ready", null],
  ];
  assert.deepEqual(await statuses(first.authority, requests), expected);
  const events = (await first.authority.events()).length;
  await first.authority.close();
  const second = await reopened(first, { capacity: 2 });
  await settled(second.authority);
  assert.deepEqual(await statuses(second.authority, requests), expected);
  assert.equal((await second.authority.events()).length, events);
  assert.equal(first.destination.effects.length, 2);
  await second.authority.close();
});

await test("CLV-049 a run that waits at a gate holds no capacity: with the bound 1, the service sends the effect of a second run", async () => {
  const started = await scene(1, ["run-1", "run-2"]);
  const { authority, destination, send } = started;
  const gate = await send({
    kind: "open-gate",
    commandId: "c-gate",
    runId: "run-1",
    gateId: "gate-1",
    expectedRevision: 2,
  });
  assert.equal(gate.kind, "accepted", JSON.stringify(gate));
  const gated = requestOf("run-1", { round: 1 });
  const free = requestOf("run-2", { round: 1 });
  for (const request of [gated, free])
    await send(request.command, request.documents);
  await settled(authority);
  assert.deepEqual(await statuses(authority, [gated, free]), [
    ["waiting", "run-not-running", null],
    ["running", null, 1],
  ]);
  assert.deepEqual(destination.effects, [free.operationId]);
  await authority.close();
});

await test("CLV-049 a free slot sends the oldest wait one time", async () => {
  const started = await scene(1, ["run-1", "run-2", "run-3"]);
  const { authority, destination, send } = started;
  const requests = [
    requestOf("run-1", { round: 1 }),
    requestOf("run-2", { round: 1 }),
    requestOf("run-3", { round: 1 }),
  ];
  for (const request of requests)
    await send(request.command, request.documents);
  await settled(authority);
  assert.deepEqual(await statuses(authority, requests), [
    ["running", null, 1],
    ["waiting", "ready", null],
    ["waiting", "ready", null],
  ]);
  const [first, second, third] = requests;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  await completed(started, first);
  await settled(authority);
  assert.deepEqual(await statuses(authority, [second, third]), [
    ["running", null, 1],
    ["waiting", "ready", null],
  ]);
  await completed(started, second);
  await settled(authority);
  assert.deepEqual(
    destination.effects,
    requests.map((request) => request.operationId),
  );
  assert.equal(
    destination.calls.filter((call) => call.startsWith("deliver")).length,
    3,
  );
  await authority.close();
});

await test("CLV-049 a second request for a resource that has an owner waits with a stored reason, and only one owner holds the claim", async () => {
  const started = await scene(4, ["run-1", "run-2"]);
  const { authority, directory, send } = started;
  const owner = requestOf("run-1", { round: 1, resource: "repository" });
  const second = requestOf("run-2", { round: 1, resource: "repository" });
  for (const request of [owner, second])
    await send(request.command, request.documents);
  await settled(authority);
  assert.deepEqual(await statuses(authority, [owner, second]), [
    ["running", null, 1],
    ["waiting", "resource", null],
  ]);
  await completed(started, owner);
  await settled(authority);
  assert.deepEqual(await statuses(authority, [owner, second]), [
    ["completed", null, null],
    ["running", null, 2],
  ]);
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT resource_key, operation_id, generation, state FROM leases",
    ),
    [
      {
        resource_key: "repository",
        operation_id: second.operationId,
        generation: 2,
        state: "held",
      },
    ],
  );
  await (await reopened(started, { capacity: 4 })).authority.close();
});

function completedBefore(
  destination: Destination,
  operationId: string,
): Delivery {
  return {
    deliver: destination.delivery.deliver,
    reconcile: (intent, signal) =>
      intent.operationId === operationId
        ? Promise.resolve({
            kind: "completed",
            receipt: "receipt-0",
            worker: "worker-1",
            result: "the result",
          })
        : destination.delivery.reconcile(intent, signal),
  };
}

await test("CLV-049 a turn that settles an operation and then grants the next one stores each outbox release with the sequence of its own event", async () => {
  const directory = await temporaryDirectory();
  const destination = fakeDestination();
  const found = requestOf("run-1", { round: 1 });
  const next = requestOf("run-2", { round: 1 });
  const authority = await openedAuthority(directory, {
    delivery: completedBefore(destination, found.operationId),
    clock: () => noon,
    timing: fastTiming,
    effects: { capacity: 1 },
  });
  const send = sender(authority, { now: noon });
  for (const runId of ["run-1", "run-2"])
    await runningRun(send, { effectLimit: 5, runId });
  for (const request of [found, next])
    await send(request.command, request.documents);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(next.operationId))?.status ===
      "running",
  );
  const types = (await authority.events()).map((event) => event.type);
  const settled = types.indexOf("operation.reconciled") + 1;
  assert.equal(types[settled], "lease.granted");
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      `SELECT released_sequence FROM outbox WHERE operation_id = '${found.operationId}'`,
    ),
    [{ released_sequence: settled }],
  );
  await (
    await reopened({ directory, destination }, { capacity: 1 })
  ).authority.close();
});

await test("CLV-049 an opening with a larger capacity grants and sends an operation that waited for a slot", async () => {
  const first = await scene(1, ["run-1", "run-2"]);
  const requests = [
    requestOf("run-1", { round: 1 }),
    requestOf("run-2", { round: 1 }),
  ];
  for (const request of requests)
    await first.send(request.command, request.documents);
  await settled(first.authority);
  await first.authority.close();
  const second = await reopened(first, { capacity: 2 });
  await settled(second.authority);
  assert.deepEqual(await statuses(second.authority, requests), [
    ["running", null, 1],
    ["running", null, 1],
  ]);
  assert.equal(first.destination.effects.length, 2);
  await second.authority.close();
});
