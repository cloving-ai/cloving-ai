import { testMilliseconds } from "./test-timing.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority, type Delivery } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  pin,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
  testAuthorityTiming,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const start = {
  kind: "start-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
};

await test("CLV-042 library message retention keeps the permanent domain receipts and their duplicate and conflict answers", async () => {
  const directory = await temporaryDirectory();
  const pruned: number[] = [];
  const service = externalService();
  const authority = await openedAuthority(directory, {
    ...service.options,
    timing: {
      ...testAuthorityTiming,
      messageRetentionMilliseconds: testMilliseconds(1),
      retentionIntervalMilliseconds: testMilliseconds(50),
    },
    instrumentation: (event) => {
      if (event.name === "solid_objects.messages.pruned")
        pruned.push(Number(event.attributes["count"]));
    },
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await deliverUntil(
    authority,
    async () =>
      (await authority.eligibleIntents()).length === 0 &&
      pruned.reduce((total, count) => total + count, 0) >= 3,
  );
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT count(*) AS count FROM solid_messages WHERE operation = 'execute'",
    ),
    [{ count: 0 }],
  );
  const reopened = await openedAuthority(directory);
  assert.deepEqual(await executePinned(reopened, admission), {
    kind: "duplicate",
    sequence: 1,
    intents: [start],
  });
  assert.deepEqual(
    await executePinned(reopened, { ...admission, workflow: `${pin}0` }),
    { kind: "rejected", reason: "conflicting-command" },
  );
  assert.equal(service.sent.length, 1);
  await reopened.close();
});

function stoppingDelivery(parts: {
  readonly stopping: AbortController;
  readonly sent: string[];
}): Delivery {
  const { stopping, sent } = parts;
  const receipt = (operationId: string): string =>
    `receipt-${String(sent.indexOf(operationId) + 1)}`;
  return {
    deliver: (intent) => {
      sent.push(intent.operationId);
      stopping.abort();
      return Promise.resolve({ receipt: receipt(intent.operationId) });
    },
    reconcile: (intent) =>
      Promise.resolve(
        sent.includes(intent.operationId)
          ? { kind: "accepted", receipt: receipt(intent.operationId) }
          : { kind: "absent" },
      ),
  };
}

await test("CLV-042 delivery workers stopped with pending effects and a queued callback complete each operation exactly once after a graceful close and reopening", async () => {
  const directory = await temporaryDirectory();
  const stopping = new AbortController();
  const sent: string[] = [];
  const delivery = stoppingDelivery({ stopping, sent });
  const first = await openedAuthority(directory, { delivery });
  for (const runId of ["run-1", "run-2", "run-3"])
    assert.equal(
      (
        await executePinned(first, {
          ...admission,
          commandId: `admit-${runId}`,
          runId,
        })
      ).kind,
      "accepted",
    );
  await first.deliver(stopping.signal);
  await first.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT status, count(*) AS count FROM solid_effects GROUP BY status ORDER BY status",
    ),
    [
      { status: "completed", count: 1 },
      { status: "pending", count: 2 },
    ],
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT count(*) AS count FROM solid_messages WHERE operation = 'deliveryCompleted' AND completed_at_ms IS NULL",
    ),
    [{ count: 1 }],
  );
  const reopened = await openedAuthority(directory, { delivery });
  await deliverUntil(
    reopened,
    async () => (await reopened.eligibleIntents()).length === 0,
  );
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent).size, 3);
  assert.deepEqual(
    (await reopened.events())
      .filter((event) => event.type === "step.dispatched")
      .map((event) => event.runId)
      .sort(),
    ["run-1", "run-2", "run-3"],
  );
  await reopened.close();
});

await test("CLV-042 actor state persisted by a newer state version is refused before any turn, leaves no message in the mailbox, and is not overwritten", async () => {
  const directory = await temporaryDirectory();
  await (await openedAuthority(directory)).close();
  alterDatabase(
    directory,
    "UPDATE solid_instances SET state_version = 2 WHERE actor_type = 'ClovingAuthority'",
  );
  for (let attempt = 0; attempt < 2; attempt += 1)
    assert.deepEqual(await openAuthority(directory), {
      kind: "refused",
      reason: "incompatible-state-version",
      detail: "stored state version 2 is newer than code version 1",
    });
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT operation FROM solid_messages WHERE completed_at_ms IS NULL",
    ),
    [],
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT state_version, state FROM solid_instances WHERE actor_type = 'ClovingAuthority'",
    ),
    [{ state_version: 2, state: '{"sequence":0,"epoch":1}' }],
  );
});

await test("CLV-042 actor state of a newer state version is refused as incompatible before its shape is read", async () => {
  const directory = await temporaryDirectory();
  await (await openedAuthority(directory)).close();
  alterDatabase(
    directory,
    `UPDATE solid_instances SET state_version = 2, state = '{"position":"first"}' WHERE actor_type = 'ClovingAuthority'`,
  );
  assert.deepEqual(await openAuthority(directory), {
    kind: "refused",
    reason: "incompatible-state-version",
    detail: "stored state version 2 is newer than code version 1",
  });
});

after(removeTemporaryDirectories);
