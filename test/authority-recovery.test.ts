import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthorityStore } from "../src/broker/authority-store.ts";
import { rebuild } from "../src/authority/reducer.ts";
import { workflowPin } from "../src/broker/workflow-pin.ts";
import { continuation, dispatch, recorded } from "./authority-fixture.ts";
import {
  alterDatabase,
  executeStored,
  manifest,
  opened,
  queryDatabase,
  storedGate,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

async function answered(): Promise<string> {
  const directory = await temporaryDirectory();
  const { store } = opened(directory);
  for (const command of storedGate)
    assert.equal(executeStored(store, command).kind, "accepted");
  store.close();
  return directory;
}

await test("CLV-007 reopening matches the projection rebuilt from committed events and keeps released intents released", async () => {
  const directory = await temporaryDirectory();
  const first = opened(directory).store;
  for (const command of storedGate)
    assert.equal(executeStored(first, command).kind, "accepted");
  const committed = { state: first.state(), events: first.events() };
  first.close();
  assert.deepEqual(rebuild(committed.events), committed.state);
  const { store } = opened(directory);
  assert.deepEqual({ state: store.state(), events: store.events() }, committed);
  assert.deepEqual(store.eligibleIntents(), [continuation]);
  store.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT kind, created_sequence, released_sequence FROM outbox ORDER BY created_sequence",
    ),
    [
      { kind: "start-run", created_sequence: 1, released_sequence: 2 },
      { kind: "continue-run", created_sequence: 4, released_sequence: null },
    ],
  );
});

const orphan = { ...manifest, name: "orphan" };

const tampered = [
  {
    name: "a reopened released intent",
    sql: "UPDATE outbox SET released_sequence = NULL WHERE kind = 'start-run'",
    detail: "intents",
  },
  {
    name: "a lost continuation",
    sql: "DELETE FROM outbox WHERE kind = 'continue-run'",
    detail: "intents",
  },
  {
    name: "a changed run status",
    sql: "UPDATE runs SET status = 'completed'",
    detail: "runs",
  },
  {
    name: "an unknown run status",
    sql: "UPDATE runs SET status = 'unknown'",
    detail: "invalid-run-row",
  },
  {
    name: "a lost command receipt",
    sql: "DELETE FROM commands WHERE command_id = 'c-4'",
    detail: "commands",
  },
  {
    name: "a moved release sequence",
    sql: "UPDATE outbox SET released_sequence = 3 WHERE kind = 'start-run'",
    detail: "outbox",
  },
  {
    name: "a moved creation sequence",
    sql: "UPDATE outbox SET created_sequence = 3 WHERE kind = 'continue-run'",
    detail: "outbox",
  },
  {
    name: "an unknown intent kind",
    sql: "UPDATE outbox SET kind = 'launch-run' WHERE kind = 'continue-run'",
    detail: "invalid-outbox-row",
  },
  {
    name: "a moved run sequence",
    sql: "UPDATE runs SET sequence = 2",
    detail: "run-sequences",
  },
  {
    name: "an invalid paused-from status",
    sql: "UPDATE runs SET paused_from = 'unknown'",
    detail: "invalid-run-row",
  },
  {
    name: "an unused definition",
    sql: `INSERT INTO definitions (pin, manifest) VALUES ('${workflowPin(orphan)}', '${JSON.stringify(orphan)}')`,
    detail: "definitions",
  },
];

for (const change of tampered)
  await test(`CLV-007 a projection with ${change.name} is refused instead of resending or losing work`, async () => {
    const directory = await answered();
    alterDatabase(directory, `PRAGMA foreign_keys = OFF; ${change.sql}`);
    assert.deepEqual(openAuthorityStore(directory), {
      kind: "refused",
      reason: "projection-mismatch",
      detail: change.detail,
    });
  });

const histories = [
  {
    name: "an event payload that its request does not produce",
    sql: `UPDATE events SET payload = '{"workflow":"pin-9"}' WHERE sequence = 1`,
    detail: "invalid-event: 1 request-mismatch",
  },
  {
    name: "a malformed event payload",
    sql: "UPDATE events SET payload = '[' WHERE sequence = 2",
    detail: "invalid-event-row: 2",
  },
  {
    name: "an unknown event type",
    sql: "UPDATE events SET type = 'run.unknown' WHERE sequence = 3",
    detail: "invalid-event-row: 3",
  },
];

for (const history of histories)
  await test(`CLV-007 a committed history with ${history.name} is refused`, async () => {
    const directory = await answered();
    alterDatabase(directory, history.sql);
    assert.deepEqual(openAuthorityStore(directory), {
      kind: "refused",
      reason: "invalid-history",
      detail: history.detail,
    });
  });

await test("CLV-007 a paused run reopens paused with the state that it paused from", async () => {
  const directory = await temporaryDirectory();
  const first = opened(directory).store;
  for (const command of [
    ...storedGate.slice(0, 2),
    {
      kind: "pause-run",
      commandId: "c-3",
      runId: "run-1",
      expectedRevision: 2,
    },
  ])
    assert.equal(executeStored(first, command).kind, "accepted");
  const committed = first.state();
  first.close();
  const { store } = opened(directory);
  assert.equal(store.state().runs["run-1"]?.status, "paused");
  assert.equal(store.state().runs["run-1"]?.pausedFrom, "running");
  assert.deepEqual(store.state(), committed);
  store.close();
});

await test("CLV-007 a committed dispatch receipt survives reopening and its continuation is never eligible again", async () => {
  const directory = await answered();
  const first = opened(directory).store;
  assert.deepEqual(first.execute(dispatch, recorded), {
    kind: "accepted",
    sequence: 5,
    intents: [],
  });
  first.close();
  const { store } = opened(directory);
  assert.deepEqual(store.eligibleIntents(), []);
  assert.deepEqual(store.events().at(-1)?.payload, {
    operationId: continuation.operationId,
    receipt: "wrun-1",
  });
  assert.deepEqual(store.execute(dispatch, recorded), {
    kind: "duplicate",
    sequence: 5,
  });
  store.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT released_sequence FROM outbox WHERE kind = 'continue-run'",
    ),
    [{ released_sequence: 5 }],
  );
});

await test("CLV-007 a reopened gate's second decision commits and both continuations survive reopening", async () => {
  const directory = await answered();
  const first = opened(directory).store;
  for (const command of [
    {
      kind: "open-gate",
      commandId: "c-5",
      runId: "run-1",
      gateId: "gate-1",
      expectedRevision: 4,
    },
    {
      kind: "decide-gate",
      commandId: "c-6",
      runId: "run-1",
      gateId: "gate-1",
      decision: "approved",
      expectedRevision: 5,
    },
  ])
    assert.equal(executeStored(first, command).kind, "accepted");
  first.close();
  const { store } = opened(directory);
  assert.deepEqual(
    store.eligibleIntents().map((intent) => intent.operationId),
    [
      continuation.operationId,
      '["cloving-operation",6,"run-1","gate","continue-run",null,"gate-1"]',
    ],
  );
  store.close();
});

after(removeTemporaryDirectories);
