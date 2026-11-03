import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ownedDatabase } from "../src/broker/actor/authority-runtime.ts";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { effectQueries } from "../src/broker/actor/effect-queries.ts";
import { text } from "../src/storage/domain-rows.ts";
import { deliverUntil, openedAuthority } from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
} from "./authority-store-fixture.ts";
import {
  effectRequest,
  effectTables,
  runningRun,
  tableRows,
  type Send,
} from "./effect-fixture.ts";
import { drop, scene, stopped, type Scene } from "./effect-stop-fixture.ts";

after(removeTemporaryDirectories);

async function refusedEffect(send: Send): Promise<void> {
  await runningRun(send, { effectLimit: 1 });
  for (const round of [1, 2]) {
    const request = effectRequest({ commandId: `c-${String(round)}`, round });
    await send(request.command, request.documents);
  }
}

async function stoppedStart(started: Scene): Promise<void> {
  const { authority, send } = started;
  const admission = { ...storedGate[0], runId: "run-2", commandId: "c-run-2" };
  assert.equal((await send(admission)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  const cancel = { ...drop, runId: "run-2", expectedRevision: 1 };
  assert.equal((await send(cancel)).kind, "accepted");
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.closure("run-2")).closure === "cancelled",
  );
}

async function storedRuns() {
  const started = await scene(stopped);
  await refusedEffect(started.send);
  await stoppedStart(started);
  const evidence = await started.authority.effects.evidence("run-1");
  const stops = await started.authority.effects.stops("run-2");
  const state = await started.authority.state();
  await started.authority.close();
  assert.equal(evidence.length, 1);
  assert.equal(stops.length, 1);
  return { directory: started.directory, evidence, stops, state };
}

await test("CLV-274 the evidence and stop reads of a run search the run indexes", async () => {
  const { directory, evidence, stops } = await storedRuns();
  const owned = await ownedDatabase(directory);
  assert.equal(owned.kind, "owned");
  const plans: string[] = [];
  const queries = effectQueries(
    (query) =>
      owned.database.connection((connection) =>
        query({
          run: (sql, parameters) => connection.run(sql, parameters),
          get: (sql, parameters) => connection.get(sql, parameters),
          all: async (sql, parameters) => {
            const rows = await connection.all(
              `EXPLAIN QUERY PLAN ${sql}`,
              parameters,
            );
            plans.push(...rows.map((row) => text(row, "detail")));
            return connection.all(sql, parameters);
          },
        }),
      ),
    { stopLimit: 3 },
  );
  try {
    assert.deepEqual(await queries.evidence("run-1"), evidence);
    assert.deepEqual(await queries.stops("run-2"), stops);
    const plan = plans.join("\n");
    assert.match(
      plan,
      /SEARCH e USING INDEX effect_evidence_run_sequence \(run_id=\?\)/,
    );
    assert.match(
      plan,
      /SEARCH stopped_operations USING INDEX stopped_operations_run \(run_id=\?\)/,
    );
    assert.doesNotMatch(plan, /SCAN/);
  } finally {
    await owned.database.close();
  }
});

const versionEight = `
DROP INDEX IF EXISTS effect_evidence_run_sequence;
DROP INDEX IF EXISTS stopped_operations_run;
DELETE FROM schema_migrations WHERE version > 8;
PRAGMA user_version = 8;
`;

const recordTables = ["events", ...effectTables];

await test("CLV-274 version 8 gains the run indexes without changing its records", async () => {
  const { directory, evidence, stops, state } = await storedRuns();
  alterDatabase(directory, versionEight);
  const records = tableRows(directory, recordTables);
  const checksums = queryDatabase(
    directory,
    "SELECT * FROM schema_migrations ORDER BY version",
  );
  const authority = await openedAuthority(directory);
  try {
    assert.equal((await authority.settings()).schemaVersion, 9);
    assert.deepEqual(await authority.state(), state);
    assert.deepEqual(await authority.effects.evidence("run-1"), evidence);
    assert.deepEqual(await authority.effects.stops("run-2"), stops);
  } finally {
    await authority.close();
  }
  assert.deepEqual(tableRows(directory, recordTables), records);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT * FROM schema_migrations WHERE version <= 8 ORDER BY version",
    ),
    checksums,
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM pragma_index_info('effect_evidence_run_sequence') ORDER BY seqno",
    ),
    [{ name: "run_id" }, { name: "sequence" }],
  );
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM pragma_index_info('stopped_operations_run') ORDER BY seqno",
    ),
    [{ name: "run_id" }],
  );
  await (await openedAuthority(directory)).close();
});

await test("CLV-274 an interrupted run index migration rolls back and can be retried", async () => {
  const { directory, state } = await storedRuns();
  alterDatabase(
    directory,
    `${versionEight}
    CREATE TRIGGER fail_run_index BEFORE INSERT ON schema_migrations WHEN NEW.version = 9 BEGIN SELECT RAISE(ABORT, 'injected-run-index'); END;`,
  );
  const refused = await openAuthority(directory);
  assert.equal(refused.kind, "refused");
  assert.match(refused.detail, /injected-run-index/);
  assert.deepEqual(queryDatabase(directory, "PRAGMA user_version"), [
    { user_version: 8 },
  ]);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM sqlite_schema WHERE name IN ('effect_evidence_run_sequence', 'stopped_operations_run')",
    ),
    [],
  );
  alterDatabase(directory, "DROP TRIGGER fail_run_index;");
  const authority = await openedAuthority(directory);
  try {
    assert.equal((await authority.settings()).schemaVersion, 9);
    assert.deepEqual(await authority.state(), state);
  } finally {
    await authority.close();
  }
});
