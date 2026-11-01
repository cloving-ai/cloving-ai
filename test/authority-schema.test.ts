import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { requiredSettingsViolation } from "../src/broker/actor/authority-connection.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  alterDatabase as change,
  queryDatabase as query,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

await test("CLV-007 every authority connection uses WAL, full synchronization, foreign keys and exclusive bounded locking", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  assert.deepEqual(await authority.settings(), {
    schemaVersion: 8,
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    lockingMode: "exclusive",
    busyTimeoutMilliseconds: 250,
  });
  await authority.close();
  assert.deepEqual(query(directory, "PRAGMA user_version"), [
    { user_version: 8 },
  ]);
  assert.match(
    JSON.stringify(
      query(
        directory,
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      ),
    ),
    /^\[\{"version":1,"checksum":"[0-9a-f]{64}"\},\{"version":2,"checksum":"[0-9a-f]{64}"\},\{"version":3,"checksum":"[0-9a-f]{64}"\},\{"version":4,"checksum":"[0-9a-f]{64}"\},\{"version":5,"checksum":"[0-9a-f]{64}"\},\{"version":6,"checksum":"[0-9a-f]{64}"\},\{"version":7,"checksum":"[0-9a-f]{64}"\},\{"version":8,"checksum":"[0-9a-f]{64}"\}\]$/,
  );
});

await test("CLV-007 an authority database from a newer schema version is refused and left unchanged", async () => {
  const directory = await temporaryDirectory();
  change(directory, "PRAGMA user_version = 9");
  assert.deepEqual(await openAuthority(directory), {
    kind: "refused",
    reason: "unsupported-schema",
    detail: "9",
  });
  assert.deepEqual(query(directory, "PRAGMA user_version"), [
    { user_version: 9 },
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
  await (await openedAuthority(directory)).close();
  change(
    directory,
    "UPDATE schema_migrations SET checksum = 'changed' WHERE version = 2",
  );
  assert.deepEqual(await openAuthority(directory), {
    kind: "refused",
    reason: "schema-mismatch",
    detail: "8",
  });
});

await test("CLV-007 an authority database whose tables or indexes differ from its schema version is refused", async () => {
  for (const sql of [
    "CREATE INDEX extra ON events (type)",
    "CREATE TABLE extra (value TEXT)",
    "DROP TABLE schema_migrations",
    "DROP INDEX deliveries_open",
  ]) {
    const directory = await temporaryDirectory();
    await (await openedAuthority(directory)).close();
    change(directory, sql);
    assert.deepEqual(await openAuthority(directory), {
      kind: "refused",
      reason: "schema-mismatch",
      detail: "8",
    });
  }
});

await test("CLV-007 a non-empty database without an authority schema is refused and left unchanged", async () => {
  const directory = await temporaryDirectory();
  change(directory, "CREATE TABLE unrelated (value TEXT)");
  assert.deepEqual(await openAuthority(directory), {
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
  assert.deepEqual(await openAuthority(directory), {
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
    schemaVersion: 8,
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
