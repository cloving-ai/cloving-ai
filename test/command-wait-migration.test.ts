import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import type { StoredState } from "../src/broker/authority-restore.ts";
import {
  alterDatabase,
  opened,
  queryDatabase,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";
import { context, opening, waitStore } from "./command-wait-fixture.ts";

const versionFour = `
DROP TABLE command_waits;
DELETE FROM schema_migrations WHERE version = 5;
PRAGMA user_version = 4;
`;

after(removeTemporaryDirectories);

await test("CLV-235 version 4 migration restores a recorded wait without renewing its deadline", async () => {
  const { store, directory } = await waitStore();
  let before: StoredState | undefined;
  try {
    assert.equal((await store.execute(opening, context)).kind, "accepted");
    before = await store.state();
  } finally {
    await store.close();
  }
  alterDatabase(directory, versionFour);
  const reopened = (await opened(directory)).store;
  try {
    assert.equal((await reopened.settings()).schemaVersion, 5);
    assert.deepEqual(await reopened.state(), before);
    assert.equal((await reopened.effects.budget("run-1"))?.spent, 0);
  } finally {
    await reopened.close();
  }
  assert.deepEqual(
    queryDatabase(directory, "SELECT name, deadline FROM command_waits"),
    [
      {
        name: "team-review",
        deadline: Date.parse(context.recordedAt) + 2_592_000_000,
      },
    ],
  );
});

await test("CLV-235 version 4 upgrades without changing legacy state or restoring any effect allowance", async () => {
  const { store, directory } = await waitStore();
  const before = await store.state();
  await store.close();
  const checksums = queryDatabase(
    directory,
    "SELECT version, checksum FROM schema_migrations WHERE version <= 4 ORDER BY version",
  );
  alterDatabase(directory, versionFour);
  const reopened = (await opened(directory)).store;
  try {
    assert.equal((await reopened.settings()).schemaVersion, 5);
    assert.deepEqual(await reopened.state(), before);
    assert.equal((await reopened.effects.budget("run-1"))?.spent, 0);
  } finally {
    await reopened.close();
  }
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT version, checksum FROM schema_migrations WHERE version <= 4 ORDER BY version",
    ),
    checksums,
  );
  assert.deepEqual(queryDatabase(directory, "SELECT * FROM command_waits"), []);
});

await test("CLV-235 an interrupted wait migration rolls back to version 4 and retries safely", async () => {
  const { store, directory } = await waitStore();
  const before = await store.state();
  await store.close();
  alterDatabase(
    directory,
    versionFour +
      `
    CREATE TRIGGER fail_wait_migration BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 5 BEGIN SELECT RAISE(ABORT, 'injected-wait-migration'); END;
  `,
  );
  const result = await openAuthority(directory);
  assert.equal(result.kind, "refused");
  assert.equal(result.reason, "storage-failure");
  assert.match(result.detail, /injected-wait-migration/);
  assert.deepEqual(queryDatabase(directory, "PRAGMA user_version"), [
    { user_version: 4 },
  ]);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM sqlite_schema WHERE name = 'command_waits'",
    ),
    [],
  );
  alterDatabase(directory, "DROP TRIGGER fail_wait_migration;");
  const retried = (await opened(directory)).store;
  try {
    assert.equal((await retried.settings()).schemaVersion, 5);
    assert.deepEqual(await retried.state(), before);
  } finally {
    await retried.close();
  }
});

await test("CLV-235 a failed wait projection write rolls back its event, command and input document", async () => {
  const { store, directory } = await waitStore();
  await store.close();
  alterDatabase(
    directory,
    `
    CREATE TRIGGER fail_wait_write BEFORE INSERT ON command_waits
    BEGIN SELECT RAISE(ABORT, 'injected-wait-write'); END;
  `,
  );
  const failing = (await opened(directory)).store;
  try {
    const result = await failing.execute(opening, context);
    assert.equal(result.kind, "failed");
    assert.equal(result.reason, "storage-failure");
  } finally {
    await failing.close();
  }
  assert.deepEqual(
    queryDatabase(directory, "SELECT name FROM command_waits"),
    [],
  );
  assert.equal(
    queryDatabase(directory, "SELECT sequence FROM events").length,
    2,
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT command_id FROM commands WHERE command_id = 'open-review'",
    ),
    [],
  );
  assert.deepEqual(
    queryDatabase(directory, "SELECT digest FROM documents"),
    [],
  );
  alterDatabase(directory, "DROP TRIGGER fail_wait_write;");
  const retried = (await opened(directory)).store;
  try {
    assert.equal((await retried.execute(opening, context)).kind, "accepted");
  } finally {
    await retried.close();
  }
});

for (const sql of [
  "DELETE FROM command_waits",
  "UPDATE command_waits SET deadline = deadline + 1",
])
  await test(`CLV-235 reopening rejects wait projection corruption: ${sql}`, async () => {
    const { store, directory } = await waitStore();
    try {
      assert.equal((await store.execute(opening, context)).kind, "accepted");
    } finally {
      await store.close();
    }
    alterDatabase(directory, sql);
    assert.deepEqual(await openAuthority(directory), {
      kind: "refused",
      reason: "projection-mismatch",
      detail: "waits",
    });
  });
