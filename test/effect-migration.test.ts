import assert from "node:assert/strict";
import { after, test } from "node:test";
import { convertAuthority } from "../src/broker/actor/authority-conversion.ts";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import {
  answeredQuestion,
  downgrade,
  executeAll,
} from "./authority-decision-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectTables,
  noon,
  sender,
  startOperation,
  tableRows,
  versionThree,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const versionThreeTables = [
  "events",
  "definitions",
  "runs",
  "commands",
  "outbox",
  "deliveries",
  "authority_identity",
  "gates",
  "run_details",
  "documents",
];

function version(directory: string): unknown {
  return queryDatabase(directory, "PRAGMA user_version");
}

function presentTables(directory: string): unknown {
  return queryDatabase(
    directory,
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${effectTables.map((name) => `'${name}'`).join(", ")}) ORDER BY name`,
  );
}

function failingMigration(condition: string): string {
  return `CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations ${condition} BEGIN SELECT RAISE(ABORT, 'injected-migration-failure'); END;`;
}

async function versionThreeDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  const receipts = await executeAll(authority, answeredQuestion);
  assert.deepEqual(
    receipts.map((receipt) => receipt.kind),
    ["accepted", "accepted", "accepted", "accepted", "accepted"],
  );
  await authority.close();
  alterDatabase(directory, versionThree);
  return directory;
}

async function refusedMigration(directory: string): Promise<void> {
  const refused = await openAuthority(directory);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.reason, "storage-failure");
  assert.match(refused.detail, /injected-migration-failure/);
}

await test("CLV-049 a version 3 state directory opens as the current schema with its version 3 rows unchanged and six empty effect tables", async () => {
  const directory = await versionThreeDirectory();
  assert.deepEqual(version(directory), [{ user_version: 3 }]);
  const before = tableRows(directory, versionThreeTables);
  const migrated = await openedAuthority(directory);
  await migrated.close();
  assert.deepEqual(version(directory), [{ user_version: 5 }]);
  assert.deepEqual(tableRows(directory, versionThreeTables), before);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT version FROM schema_migrations ORDER BY version",
    ),
    [
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ],
  );
  assert.deepEqual(
    tableRows(directory, effectTables),
    effectTables.map(() => []),
  );
});

await test("CLV-049 the schema texts of versions 1, 2 and 3 keep the checksums of the accepted CLV-008 package", async () => {
  const directory = await temporaryDirectory();
  await (await openedAuthority(directory)).close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT version, checksum FROM schema_migrations WHERE version < 4 ORDER BY version",
    ),
    [
      {
        version: 1,
        checksum:
          "d5b0c8b8c3e81098f26fae45c54d1c0f45670eef9aad6551e18a6a4ecd37e251",
      },
      {
        version: 2,
        checksum:
          "8ab4f6b00fcff9ed5229d98864254dd636add8e0e8adc3f15f30c049dabff1dc",
      },
      {
        version: 3,
        checksum:
          "15f62c82de06361935bd8dc906ec01ca1e01ef06d3bc81dc5104a0049d0e5c4e",
      },
    ],
  );
});

await test("CLV-049 a version 3 history with a stop report for a start gives one stopped operation row at the migration", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  const send = sender(authority, { now: noon });
  for (const command of storedGate.slice(0, 2)) await send(command);
  const stopped = await send({
    kind: "report-observation",
    commandId: "c-stop",
    runId: "run-1",
    condition: "stopped",
    reason: "worker-exit",
    operationId: startOperation,
  });
  assert.equal(stopped.kind, "accepted", JSON.stringify(stopped));
  await authority.close();
  alterDatabase(directory, versionThree);
  const migrated = await openedAuthority(directory);
  await migrated.close();
  assert.deepEqual(
    queryDatabase(directory, "SELECT * FROM stopped_operations"),
    [{ operation_id: startOperation, run_id: "run-1", sequence: 3 }],
  );
});

await test("CLV-049 an interrupted migration to version 4 leaves version 3 with no effect table, and the next opening completes it", async () => {
  const directory = await versionThreeDirectory();
  alterDatabase(directory, failingMigration(""));
  const before = tableRows(directory, versionThreeTables);
  await refusedMigration(directory);
  assert.deepEqual(version(directory), [{ user_version: 3 }]);
  assert.deepEqual(tableRows(directory, versionThreeTables), before);
  assert.deepEqual(presentTables(directory), []);
  alterDatabase(directory, "DROP TRIGGER fail_migration;");
  const completed = await openedAuthority(directory);
  await completed.close();
  assert.deepEqual(version(directory), [{ user_version: 5 }]);
  assert.deepEqual(tableRows(directory, versionThreeTables), before);
});

await test("CLV-049 a version 3 state directory with a changed record is refused before the migration and stays at version 3", async () => {
  const directory = await versionThreeDirectory();
  alterDatabase(directory, "UPDATE run_details SET generation = 9");
  assert.deepEqual(await openAuthority(directory), {
    kind: "refused",
    reason: "projection-mismatch",
    detail: "details",
  });
  assert.deepEqual(version(directory), [{ user_version: 3 }]);
  assert.deepEqual(presentTables(directory), []);
});

await test("CLV-049 the conversion of a version 3 state directory with a changed record is refused before the migration and leaves version 3", async () => {
  const directory = await versionThreeDirectory();
  alterDatabase(directory, "UPDATE run_details SET generation = 9");
  assert.deepEqual(await convertAuthority(directory), {
    kind: "refused",
    reason: "projection-mismatch",
    detail: "details",
  });
  assert.deepEqual(version(directory), [{ user_version: 3 }]);
  assert.deepEqual(presentTables(directory), []);
});

await test("CLV-049 the conversion upgrades a version 3 state directory to the current schema", async () => {
  const directory = await versionThreeDirectory();
  const conversion = await convertAuthority(directory);
  assert.equal(conversion.kind, "converted", JSON.stringify(conversion));
  assert.deepEqual(version(directory), [{ user_version: 5 }]);
  await (await openedAuthority(directory)).close();
});

await test("CLV-049 a version 2 state directory goes to the current schema in three transactions, and an interruption of the second one leaves version 3", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  for (const command of storedGate) await executePinned(first, command);
  await first.close();
  alterDatabase(directory, downgrade);
  assert.deepEqual(version(directory), [{ user_version: 2 }]);
  alterDatabase(directory, failingMigration("WHEN NEW.version = 4"));
  await refusedMigration(directory);
  assert.deepEqual(version(directory), [{ user_version: 3 }]);
  assert.deepEqual(presentTables(directory), []);
  assert.equal(queryDatabase(directory, "SELECT run_id FROM gates").length, 1);
  alterDatabase(directory, "DROP TRIGGER fail_migration;");
  const completed = await openedAuthority(directory);
  const state = await completed.state();
  await completed.close();
  assert.deepEqual(version(directory), [{ user_version: 5 }]);
  assert.equal(state.gates["run-1 gate-1"]?.kind, "untyped");
});
