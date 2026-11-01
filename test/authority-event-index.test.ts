import assert from "node:assert/strict";
import { after, test } from "node:test";
import { authorityQueries } from "../src/broker/actor/authority-queries.ts";
import { ownedDatabase } from "../src/broker/actor/authority-runtime.ts";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { text } from "../src/storage/domain-rows.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import { answeredQuestion, executeAll } from "./authority-decision-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-247 admission reads search a persistent run and event type index", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  await executeAll(authority, answeredQuestion);
  await authority.close();
  const owned = await ownedDatabase(directory);
  assert.equal(owned.kind, "owned");
  const plans: string[] = [];
  const queries = authorityQueries((query) =>
    owned.database.connection((connection) =>
      query({
        all: (sql, parameters) => connection.all(sql, parameters),
        run: (sql, parameters) => connection.run(sql, parameters),
        get: async (sql, parameters) => {
          const rows = await connection.all(
            `EXPLAIN QUERY PLAN ${sql}`,
            parameters,
          );
          plans.push(...rows.map((row) => text(row, "detail")));
          return connection.get(sql, parameters);
        },
      }),
    ),
  );
  try {
    assert.partialDeepStrictEqual(await queries.run("run-1"), {
      admissionCommandId: "c-1",
    });
    assert.match(
      plans.join("\n"),
      /SEARCH c USING INDEX events_run_type_sequence \(run_id=\? AND type=\?\)/,
    );
    assert.doesNotMatch(plans.join("\n"), /SCAN c/);
  } finally {
    await owned.database.close();
  }
});

async function versionSeven() {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  await executeAll(authority, answeredQuestion);
  const before = await authority.state();
  await authority.close();
  alterDatabase(
    directory,
    `DROP INDEX IF EXISTS events_run_type_sequence;
     DELETE FROM schema_migrations WHERE version > 7;
     PRAGMA user_version = 7;`,
  );
  return { directory, before };
}

await test("CLV-247 version 7 gains the admission index without changing history or projections", async () => {
  const { directory, before } = await versionSeven();
  const history = queryDatabase(
    directory,
    "SELECT * FROM events ORDER BY sequence",
  );
  const checksums = queryDatabase(
    directory,
    "SELECT * FROM schema_migrations ORDER BY version",
  );
  const authority = await openedAuthority(directory);
  try {
    assert.equal((await authority.settings()).schemaVersion, 8);
    assert.deepEqual(await authority.state(), before);
    assert.partialDeepStrictEqual(await authority.queries.run("run-1"), {
      admissionCommandId: "c-1",
    });
  } finally {
    await authority.close();
  }
  assert.deepEqual(
    queryDatabase(directory, "SELECT * FROM events ORDER BY sequence"),
    history,
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT * FROM schema_migrations WHERE version <= 7 ORDER BY version",
    ),
    checksums,
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM pragma_index_info('events_run_type_sequence') ORDER BY seqno",
    ),
    [{ name: "run_id" }, { name: "type" }, { name: "sequence" }],
  );
  await (await openedAuthority(directory)).close();
});

await test("CLV-247 an interrupted admission index migration rolls back and can be retried", async () => {
  const { directory, before } = await versionSeven();
  alterDatabase(
    directory,
    `CREATE TRIGGER fail_event_index BEFORE INSERT ON schema_migrations WHEN NEW.version = 8 BEGIN SELECT RAISE(ABORT, 'injected-event-index'); END;`,
  );
  const refused = await openAuthority(directory);
  assert.equal(refused.kind, "refused");
  assert.match(refused.detail, /injected-event-index/);
  assert.deepEqual(queryDatabase(directory, "PRAGMA user_version"), [
    { user_version: 7 },
  ]);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM sqlite_schema WHERE name = 'events_run_type_sequence'",
    ),
    [],
  );
  alterDatabase(directory, "DROP TRIGGER fail_event_index;");
  const authority = await openedAuthority(directory);
  try {
    assert.equal((await authority.settings()).schemaVersion, 8);
    assert.deepEqual(await authority.state(), before);
  } finally {
    await authority.close();
  }
});
