import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync, StatementSync } from "node:sqlite";
import {
  actorState,
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
  storedCounts,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  pin,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const start = {
  kind: "start-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
};

const injections = [
  {
    name: "after the earlier domain writes",
    sql: "CREATE TRIGGER inject BEFORE INSERT ON outbox WHEN (SELECT count(*) FROM events) = 1 AND (SELECT count(*) FROM runs) = 1 AND (SELECT count(*) FROM commands) = 1 BEGIN SELECT RAISE(ABORT, 'injected-failure-after-domain-writes'); END;",
    cause: /^injected-failure-after-domain-writes$/,
  },
  {
    name: "after the domain writes and the actor state write",
    sql: "CREATE TRIGGER inject BEFORE INSERT ON solid_effects WHEN (SELECT count(*) FROM deliveries) = 1 AND (SELECT json_extract(state, '$.sequence') FROM solid_instances WHERE actor_type = 'ClovingAuthority') = 1 BEGIN SELECT RAISE(ABORT, 'injected-failure-after-domain-and-state-writes'); END;",
    cause: /^injected-failure-after-domain-and-state-writes$/,
  },
  {
    name: "at COMMIT through a deferred foreign key",
    sql: "CREATE TRIGGER inject AFTER INSERT ON events BEGIN INSERT INTO commands (command_id, request, sequence) VALUES ('injected', '{}', 1000000); END;",
    cause: /^FOREIGN KEY constraint failed$/,
  },
];

const empty = { count: 0 };

await test("CLV-179 operation polling reads delivery records without rebuilding unrelated projections", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await executePinned(authority, admission);
  const expected = await authority.operations();
  assert.equal(expected.length, 1);
  assert.equal(expected[0]?.deliveries.length, 1);
  const descriptor = Object.getOwnPropertyDescriptor(
    DatabaseSync.prototype,
    "prepare",
  );
  assert.ok(descriptor);
  const prepare: unknown = descriptor.value;
  assert.equal(typeof prepare, "function");
  const statements: string[] = [];
  DatabaseSync.prototype.prepare = function (sql) {
    statements.push(sql);
    assert.ok(typeof prepare === "function");
    const statement: unknown = Reflect.apply(prepare, this, [sql]);
    assert.ok(statement instanceof StatementSync);
    return statement;
  };
  try {
    assert.deepEqual(await authority.operations(), expected);
    assert.deepEqual(
      statements.filter((sql) =>
        /\bFROM (?:definitions|runs|commands|gates|run_details)\b/i.test(sql),
      ),
      [],
    );
    assert.ok(statements.some((sql) => /\bFROM outbox\b/i.test(sql)));
    assert.ok(statements.some((sql) => /\bFROM deliveries\b/i.test(sql)));
  } finally {
    Object.defineProperty(DatabaseSync.prototype, "prepare", descriptor);
    await authority.close();
  }
});

for (const injection of injections)
  await test(`CLV-042 a failure ${injection.name} rolls back the actor sequence, the domain rows and the staged effect together`, async () => {
    const directory = await temporaryDirectory();
    await (await openedAuthority(directory)).close();
    alterDatabase(directory, injection.sql);
    const authority = await openedAuthority(directory);
    const receipt = await executePinned(authority, admission);
    assert.equal(receipt.kind, "failed");
    assert.equal(receipt.reason, "storage-failure");
    assert.match(receipt.detail, injection.cause);
    assert.deepEqual(await executePinned(authority, admission), {
      kind: "failed",
      reason: "storage-unavailable",
      detail: "closed after storage failure",
    });
    await assert.rejects(authority.state(), /authority-unavailable/);
    await authority.close();
    assert.deepEqual(storedCounts(directory), {
      events: [empty],
      commands: [empty],
      runs: [empty],
      definitions: [empty],
      outbox: [empty],
      deliveries: [empty],
      solid_effects: [empty],
    });
    assert.deepEqual(actorState(directory), [
      { state: '{"sequence":0,"epoch":2}' },
    ]);

    alterDatabase(directory, "DROP TRIGGER inject");
    const service = externalService();
    const repaired = await openedAuthority(directory, service.options);
    assert.deepEqual(await executePinned(repaired, admission), {
      kind: "accepted",
      sequence: 1,
      intents: [start],
    });
    await deliverUntil(
      repaired,
      async () => (await repaired.eligibleIntents()).length === 0,
    );
    assert.deepEqual(
      service.sent.map((intent) => [intent.operationId, intent.workflow]),
      [[start.operationId, pin]],
    );
    assert.deepEqual(
      (await repaired.events()).map((event) => [event.sequence, event.type]),
      [
        [1, "run.created"],
        [2, "step.dispatched"],
      ],
    );
    await repaired.close();
  });

after(removeTemporaryDirectories);
