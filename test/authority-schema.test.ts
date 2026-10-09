import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthorityStore } from "../src/broker/authority-store.ts";
import { requiredSettingsViolation } from "../src/storage/authority-database.ts";
import {
  alterDatabase as change,
  opened,
  queryDatabase as query,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

await test("CLV-007 every authority connection uses WAL, full synchronization, foreign keys and exclusive bounded locking", async () => {
  const directory = await temporaryDirectory();
  const { store } = opened(directory);
  assert.deepEqual(store.settings(), {
    schemaVersion: 1,
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    lockingMode: "exclusive",
    busyTimeoutMilliseconds: 250,
  });
  store.close();
  assert.deepEqual(query(directory, "PRAGMA user_version"), [
    { user_version: 1 },
  ]);
  const [migration] = query(
    directory,
    "SELECT version, checksum FROM schema_migrations",
  );
  assert.match(
    JSON.stringify(migration),
    /^\{"version":1,"checksum":"[0-9a-f]{64}"\}$/,
  );
});

await test("CLV-007 an authority database from a newer schema version is refused and left unchanged", async () => {
  const directory = await temporaryDirectory();
  change(directory, "PRAGMA user_version = 2");
  assert.deepEqual(openAuthorityStore(directory), {
    kind: "refused",
    reason: "unsupported-schema",
    detail: "2",
  });
  assert.deepEqual(query(directory, "PRAGMA user_version"), [
    { user_version: 2 },
  ]);
  assert.deepEqual(query(directory, "PRAGMA journal_mode"), [
    { journal_mode: "delete" },
  ]);
  assert.deepEqual(
    query(directory, "SELECT name FROM sqlite_schema WHERE type = 'table'"),
    [],
  );
});

await test("CLV-007 an authority database whose recorded schema checksum differs is refused", async () => {
  const directory = await temporaryDirectory();
  opened(directory).store.close();
  change(directory, "UPDATE schema_migrations SET checksum = 'changed'");
  assert.deepEqual(openAuthorityStore(directory), {
    kind: "refused",
    reason: "schema-mismatch",
    detail: "1",
  });
});

await test("CLV-007 an authority database whose tables or indexes differ from its schema version is refused", async () => {
  for (const sql of [
    "CREATE INDEX extra ON events (type)",
    "CREATE TABLE extra (value TEXT)",
    "DROP TABLE schema_migrations",
  ]) {
    const directory = await temporaryDirectory();
    opened(directory).store.close();
    change(directory, sql);
    assert.deepEqual(openAuthorityStore(directory), {
      kind: "refused",
      reason: "schema-mismatch",
      detail: "1",
    });
  }
});

await test("CLV-007 a non-empty database without an authority schema is refused and left unchanged", async () => {
  const directory = await temporaryDirectory();
  change(directory, "CREATE TABLE unrelated (value TEXT)");
  assert.deepEqual(openAuthorityStore(directory), {
    kind: "refused",
    reason: "foreign-database",
    detail: "0",
  });
  assert.deepEqual(query(directory, "PRAGMA journal_mode"), [
    { journal_mode: "delete" },
  ]);
  assert.deepEqual(
    query(directory, "SELECT name FROM sqlite_schema ORDER BY name"),
    [{ name: "unrelated" }],
  );
});

await test("CLV-007 a schema mismatch is refused before the file changes its journal mode", async () => {
  const directory = await temporaryDirectory();
  change(
    directory,
    "CREATE TABLE events (sequence INTEGER PRIMARY KEY); PRAGMA user_version = 1",
  );
  assert.deepEqual(openAuthorityStore(directory), {
    kind: "refused",
    reason: "schema-mismatch",
    detail: "1",
  });
  assert.deepEqual(query(directory, "PRAGMA journal_mode"), [
    { journal_mode: "delete" },
  ]);
});

await test("CLV-007 a connection that does not report every required setting is a storage failure", () => {
  const required = {
    schemaVersion: 1,
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    lockingMode: "exclusive",
    busyTimeoutMilliseconds: 250,
  };
  assert.equal(requiredSettingsViolation(required), null);
  assert.deepEqual(
    [
      { journalMode: "delete" },
      { synchronous: 1 },
      { foreignKeys: 0 },
      { lockingMode: "normal" },
      { busyTimeoutMilliseconds: 0 },
    ].map((changed) => requiredSettingsViolation({ ...required, ...changed })),
    [
      "journalMode=delete",
      "synchronous=1",
      "foreignKeys=0",
      "lockingMode=normal",
      "busyTimeoutMilliseconds=0",
    ],
  );
});

after(removeTemporaryDirectories);
