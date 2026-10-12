import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority, Delivery } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";
import {
  effectRequest,
  fakeDestination,
  noon,
  runningRun,
  sender,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const options = { clock: (): string => noon, timing: fastTiming };
const request = effectRequest({ commandId: "c-request", round: 1 });
const { operationId } = request;

async function stored(authority: Authority): Promise<unknown> {
  const operation = await authority.effects.operation(operationId);
  const records = await authority.operations();
  return {
    operation: [operation?.status, operation?.leaseGeneration],
    events: (await authority.events()).map((event) => event.type).slice(2),
    attempts: records
      .filter((record) => record.operationId === operationId)
      .flatMap((record) =>
        record.deliveries.map((item) => [
          item.purpose,
          item.outcome,
          item.epoch,
        ]),
      ),
    eligible: (await authority.eligibleIntents()).map((intent) => intent.kind),
  };
}

await test("CLV-049 the lease, the attempt, the event and the intent of a protected effect are in storage before the fake adapter gets the call", async () => {
  const destination = fakeDestination();
  const observed: unknown[] = [];
  const holder: { authority?: Authority } = {};
  const delivery: Delivery = {
    deliver: destination.delivery.deliver,
    reconcile: async (intent, signal) => {
      if (intent.kind === "protected-effect" && holder.authority !== undefined)
        observed.push(await stored(holder.authority));
      return destination.delivery.reconcile(intent, signal);
    },
  };
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...options,
    delivery,
  });
  holder.authority = authority;
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  await send(request.command, request.documents);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  assert.deepEqual(observed, [
    {
      operation: ["dispatch-pending", 1],
      events: ["effect.requested", "lease.granted"],
      attempts: [["dispatch", null, authority.epoch]],
      eligible: ["protected-effect"],
    },
  ]);
  assert.deepEqual(destination.calls, [
    `reconcile ${operationId}`,
    `deliver ${operationId}`,
  ]);
  await authority.close();
});

const tables = [
  "events",
  "commands",
  "outbox",
  "deliveries",
  "dispatch_attempts",
  "operations",
  "leases",
  "effect_evidence",
  "documents",
  "solid_effects",
];

function counts(directory: string): unknown {
  return [
    ...tables.map((table) =>
      queryDatabase(directory, `SELECT count(*) AS count FROM ${table}`),
    ),
    queryDatabase(directory, "SELECT spent FROM run_budgets"),
    queryDatabase(
      directory,
      "SELECT state FROM solid_instances WHERE actor_type = 'ClovingAuthority'",
    ),
  ];
}

const failure = "BEGIN SELECT RAISE(ABORT, 'injected-commit-failure'); END;";

for (const [name, trigger] of [
  ["at the lease row", "BEFORE INSERT ON leases"],
  [
    "at the attempt row",
    "BEFORE INSERT ON dispatch_attempts WHEN NEW.lease_generation IS NOT NULL",
  ],
  [
    "at the native effect row",
    "BEFORE INSERT ON solid_effects WHEN json_extract(NEW.arguments, '$.kind') = 'protected-effect'",
  ],
] as const)
  await test(`CLV-049 a commit failure from the test ${name} leaves no lease, no attempt, no event and no work for a send, and the retry after a reopening admits one operation`, async () => {
    const directory = await temporaryDirectory();
    const first = await openedAuthority(directory);
    await runningRun(sender(first, { now: noon }), { effectLimit: 5 });
    await first.close();
    alterDatabase(directory, `CREATE TRIGGER inject ${trigger} ${failure}`);
    const authority = await openedAuthority(directory);
    const before = (await authority.events()).length;
    const receipt = await sender(authority, { now: noon })(
      request.command,
      request.documents,
    );
    assert.equal(receipt.kind, "failed");
    assert.equal(receipt.reason, "storage-failure");
    assert.match(receipt.detail, /injected-commit-failure/);
    await authority.close();
    assert.deepEqual(counts(directory), [
      [{ count: before }],
      [{ count: before }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ spent: 0 }],
      [{ state: '{"sequence":2,"epoch":2}' }],
    ]);
    alterDatabase(directory, "DROP TRIGGER inject");
    const destination = fakeDestination();
    const repaired = await openedAuthority(directory, {
      ...options,
      delivery: destination.delivery,
    });
    const retried = await sender(repaired, { now: noon })(
      request.command,
      request.documents,
    );
    assert.deepEqual(
      [retried.kind, Reflect.get(retried, "disposition")],
      ["accepted", "admitted"],
    );
    await deliverUntil(
      repaired,
      async () =>
        (await repaired.effects.operation(operationId))?.status === "running",
    );
    assert.deepEqual(destination.effects, [operationId]);
    await repaired.close();
  });

async function killedAfterCommit(directory: string): Promise<void> {
  await withChild(
    { script: "effect-child.ts", parameters: [directory, "commit"] },
    async (child) => {
      await child.waitFor("committed");
      assert.deepEqual(await child.kill(), { code: null, signal: "SIGKILL" });
    },
  );
}

await test("CLV-049 after a process kill between the intent commit and the send, the restart sends the same operation one time", async () => {
  const directory = await temporaryDirectory();
  await killedAfterCommit(directory);
  const destination = fakeDestination();
  const authority = await openedAuthority(directory, {
    ...options,
    delivery: destination.delivery,
  });
  assert.equal(
    (await authority.effects.operation(operationId))?.status,
    "dispatch-pending",
  );
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  assert.deepEqual(destination.calls, [
    `reconcile ${operationId}`,
    `deliver ${operationId}`,
  ]);
  assert.deepEqual(destination.effects, [operationId]);
  const records = await authority.operations();
  assert.deepEqual(
    records
      .filter((record) => record.operationId === operationId)
      .map((record) => record.deliveries.map((item) => item.outcome)),
    [["accepted"]],
  );
  const again = await sender(authority, { now: noon })(
    { ...request.command, commandId: "c-request-again" },
    request.documents,
  );
  assert.equal(Reflect.get(again, "disposition"), "existing");
  await authority.close();
});

await test("CLV-049 after a process kill in the turn of a request, before its commit, the restart completes the stored request one time: one operation, a repeat of the request is a duplicate, and the destination gets one send", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "effect-child.ts", parameters: [directory, "stop-in-request"] },
    async (child) => {
      assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
      assert.deepEqual(child.lines, ["ready"]);
    },
  );
  assert.deepEqual(
    queryDatabase(directory, "SELECT type FROM events ORDER BY sequence"),
    [{ type: "run.created" }, { type: "run.started" }],
  );
  const destination = fakeDestination();
  const authority = await openedAuthority(directory, {
    ...options,
    delivery: destination.delivery,
  });
  assert.deepEqual(
    (await authority.events()).map((event) => event.type).slice(2),
    ["effect.requested", "lease.granted"],
  );
  const repeated = await sender(authority, { now: noon })(
    request.command,
    request.documents,
  );
  assert.deepEqual(
    [repeated.kind, Reflect.get(repeated, "sequence")],
    ["duplicate", 3],
  );
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  assert.deepEqual(destination.effects, [operationId]);
  assert.equal(
    (await authority.events()).filter(
      (event) => event.type === "effect.requested",
    ).length,
    1,
  );
  await authority.close();
});
