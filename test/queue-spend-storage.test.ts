import assert from "node:assert/strict";
import { test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { ownedDatabase } from "../src/broker/actor/authority-runtime.ts";
import { effectQueries } from "../src/broker/actor/effect-queries.ts";
import { queueSpend } from "../src/service/queue-spend.ts";
import { text } from "../src/storage/domain-rows.ts";
import { alterDatabase, queryDatabase } from "./authority-store-fixture.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";

await test("CLV-241 turn queries index the settlement window and open work separately", () =>
  withQueueSpend(async (scene) => {
    scene.clock.now = "2026-10-08T12:00:00.000Z";
    const expired = await scene.begin("expired");
    await scene.turn(expired, { costUsd: 1 });
    await scene.finish(expired);
    scene.clock.now = "2026-10-10T12:00:00.000Z";
    const recent = await scene.begin("recent");
    await scene.turn(recent, { costUsd: 2 });
    await scene.pendingTurn(recent, 2);
    await scene.stop();
    const owned = await ownedDatabase(scene.harness.stateDirectory);
    assert.equal(owned.kind, "owned");
    const plans: unknown[] = [];
    const queries = effectQueries(
      (query) =>
        owned.database.connection((connection) =>
          query({
            get: (sql, parameters) => connection.get(sql, parameters),
            run: (sql, parameters) => connection.run(sql, parameters),
            all: async (sql, parameters) => {
              plans.push(
                (
                  await connection.all(`EXPLAIN QUERY PLAN ${sql}`, parameters)
                ).map((row) => text(row, "detail")),
              );
              return connection.all(sql, parameters);
            },
          }),
        ),
      { stopLimit: 1 },
    );
    try {
      const turns = await queries.workerTurns({
        after: "2026-10-09T12:00:00.000Z",
        through: scene.clock.now,
      });
      assert.deepEqual(
        turns.map((turn) => turn.runId),
        [recent, recent],
      );
      assert.equal(plans.length, 2);
      assert.match(
        JSON.stringify(plans[0]),
        /SEARCH e USING (?:COVERING )?INDEX events_spend_window/,
      );
      assert.match(JSON.stringify(plans[0]), /operations_worker_settled/);
      assert.match(JSON.stringify(plans[1]), /operations_worker_open/);
    } finally {
      await owned.database.close();
    }
  }));

await test("CLV-241 version 6 gains spending indexes without resetting spend or operations", () =>
  withQueueSpend(async (scene) => {
    const runId = await scene.begin("stored");
    await scene.turn(runId, { costUsd: 17 });
    await scene.finish(runId);
    await scene.stop();
    const directory = scene.harness.stateDirectory;
    alterDatabase(
      directory,
      `
      DROP INDEX IF EXISTS events_run_type_sequence;
      DROP INDEX IF EXISTS events_spend_window;
      DROP INDEX IF EXISTS operations_worker_settled;
      DROP INDEX IF EXISTS operations_worker_open;
      DELETE FROM schema_migrations WHERE version > 6;
      PRAGMA user_version = 6;
    `,
    );
    const operations = queryDatabase(directory, "SELECT * FROM operations");
    const opening = await openAuthority(directory);
    assert.equal(opening.kind, "opened");
    try {
      assert.equal((await opening.authority.settings()).schemaVersion, 8);
      const spending = await queueSpend({
        authority: opening.authority,
        clock: () => scene.clock.now,
        queueDailySpendLimitUsd: 20,
      });
      assert.deepEqual(spending["spend"], {
        limitUsd: 20,
        spentUsd: 17,
        unknownTurns: 0,
        turnsInWork: 0,
        windowHours: 24,
        holding: true,
      });
    } finally {
      await opening.authority.close();
    }
    assert.deepEqual(
      queryDatabase(directory, "SELECT * FROM operations"),
      operations,
    );
  }));
