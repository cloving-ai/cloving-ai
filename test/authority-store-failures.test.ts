import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { openAuthorityStore } from "../src/broker/authority-store.ts";
import { continuation } from "./authority-fixture.ts";
import { lockContention } from "../src/storage/authority-database.ts";
import {
  alterDatabase as alter,
  executeStored,
  opened,
  storedGate,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const decision = storedGate[3] ?? {};

async function waitingGate(): Promise<string> {
  const directory = await temporaryDirectory();
  const { store } = opened(directory);
  for (const command of storedGate.slice(0, 3))
    assert.equal(executeStored(store, command).kind, "accepted");
  store.close();
  return directory;
}

const failures = [
  {
    name: "a failed outbox write",
    trigger:
      "CREATE TRIGGER inject BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected-outbox-failure'); END;",
    detail: "injected-outbox-failure",
  },
  {
    name: "a failed commit",
    trigger:
      "CREATE TRIGGER inject AFTER INSERT ON events BEGIN INSERT INTO commands (command_id, request, sequence) VALUES ('injected', '{}', 1000000); END;",
    detail: "FOREIGN KEY constraint failed",
  },
];

for (const failure of failures)
  await test(`CLV-007 ${failure.name} neither acknowledges the answer nor grants its continuation`, async () => {
    const directory = await waitingGate();
    alter(directory, failure.trigger);
    const { store } = opened(directory);
    const receipt = {
      kind: "failed",
      reason: "storage-failure",
      detail: failure.detail,
    };
    assert.deepEqual(executeStored(store, decision), receipt);
    assert.equal(store.state().sequence, 3);
    assert.equal(store.events().length, 3);
    assert.deepEqual(store.eligibleIntents(), []);
    assert.deepEqual(executeStored(store, decision), {
      kind: "failed",
      reason: "storage-unavailable",
      detail: "closed after storage failure",
    });
    store.close();
    store.close();

    const reopened = opened(directory).store;
    assert.equal(reopened.state().sequence, 3);
    assert.equal(reopened.state().commands["c-4"], undefined);
    assert.deepEqual(reopened.eligibleIntents(), []);
    reopened.close();

    alter(directory, "DROP TRIGGER inject");
    const repaired = opened(directory).store;
    assert.deepEqual(executeStored(repaired, decision), {
      kind: "accepted",
      sequence: 4,
      intents: [continuation],
    });
    repaired.close();
  });

await test("CLV-007 an unwritable authority database is refused as a storage failure", async () => {
  const directory = await waitingGate();
  await chmod(join(directory, "authority.sqlite"), 0o400);
  assert.deepEqual(openAuthorityStore(directory), {
    kind: "refused",
    reason: "storage-failure",
    detail: "disk I/O error",
  });
});

await test("CLV-007 a stored value that cannot be read is refused and releases the authority", async () => {
  const directory = await waitingGate();
  alter(directory, "UPDATE runs SET revision = 9007199254740993");
  const opening = openAuthorityStore(directory);
  assert.equal(opening.kind, "refused");
  assert.match(JSON.stringify(opening), /storage-failure.*too large/);
  alter(directory, "UPDATE runs SET revision = 3");
  const { store } = opened(directory);
  assert.equal(store.state().sequence, 3);
  store.close();
});

await test("CLV-007 extended busy codes count as lock contention and other codes do not", () => {
  assert.deepEqual(
    [5, 261, 517, 773, 1, 6, 10, undefined].map((errcode) =>
      lockContention(Object.assign(new Error("sqlite"), { errcode })),
    ),
    [true, true, true, true, false, false, false, false],
  );
});

after(removeTemporaryDirectories);
