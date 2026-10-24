import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  authorityQueries,
  type AuthorityQueries,
} from "../src/broker/actor/authority-queries.ts";
import { ownedDatabase } from "../src/broker/actor/authority-runtime.ts";
import { createSchema } from "../src/storage/domain-schema.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

async function history() {
  const owned = await ownedDatabase(await temporaryDirectory());
  assert.equal(owned.kind, "owned");
  const { database } = owned;
  await database.transaction(createSchema);
  const rows: unknown[] = [];
  let failures = 0;
  const queries = (): AuthorityQueries =>
    authorityQueries((query) =>
      database.connection((connection) =>
        query({
          get: (sql, parameters) => connection.get(sql, parameters),
          run: (sql, parameters) => connection.run(sql, parameters),
          all: async (sql, parameters) => {
            if (failures > 0) {
              failures -= 1;
              throw new Error("origin-read-failed");
            }
            const result = await connection.all(sql, parameters);
            rows.push(...result);
            return result;
          },
        }),
      ),
    );
  return {
    queries,
    rows,
    fail: () => {
      failures += 1;
    },
    close: () => database.close(),
    append: (event: {
      readonly runId: string;
      readonly type: string;
      readonly payload: unknown;
    }) =>
      database.connection((connection) =>
        connection.run(
          "INSERT INTO events (type, run_id, command_id, recorded_at, request, payload) VALUES (?, ?, ?, '2026-10-24T12:00:00Z', '{}', ?)",
          [
            event.type,
            event.runId,
            `${event.runId}:${event.type}`,
            JSON.stringify(event.payload),
          ],
        ),
      ),
  };
}

async function withHistory(
  body: (stored: Awaited<ReturnType<typeof history>>) => Promise<void>,
): Promise<void> {
  const stored = await history();
  try {
    await body(stored);
  } finally {
    await stored.close();
  }
}

await test("CLV-183 origin queries reuse history, load only new runs and recover a failed refresh", () =>
  withHistory(async (stored) => {
    await stored.append({ runId: "root", type: "run.created", payload: {} });
    const queries = stored.queries();
    const first = await queries.runOrigins();
    assert.deepEqual(first, { root: { parentRunId: null, chainId: "root" } });
    assert.equal(await queries.runOrigins(), first);
    assert.equal(stored.rows.length, 1);
    await stored.append({ runId: "root", type: "run.started", payload: {} });
    assert.equal(await queries.runOrigins(), first);
    assert.equal(stored.rows.length, 1);
    await stored.append({
      runId: "child",
      type: "run.created",
      payload: { parentRunId: "root", chainId: "root" },
    });
    stored.fail();
    await assert.rejects(queries.runOrigins(), /origin-read-failed/);
    const refreshed = await Promise.all(
      Array.from({ length: 4 }, () => queries.runOrigins()),
    );
    const expected = {
      ...first,
      child: { parentRunId: "root", chainId: "root" },
    };
    for (const origins of refreshed) {
      assert.deepEqual(origins, expected);
      assert.equal(origins, refreshed[0]);
    }
    assert.equal(stored.rows.length, 2);
    assert.deepEqual(await stored.queries().runOrigins(), expected);
    assert.deepEqual(first, { root: { parentRunId: null, chainId: "root" } });
  }));

await test("CLV-183 link queries reuse the origin index and refresh children only for new runs", () =>
  withHistory(async (stored) => {
    const queries = stored.queries();
    assert.deepEqual(await queries.runLinks(), {});
    await stored.append({ runId: "root", type: "run.created", payload: {} });
    const before = await queries.runLinks();
    assert.deepEqual(before, {
      root: { parentRunId: null, chainId: "root", childRunIds: [] },
    });
    assert.equal(await queries.runLinks(), before);
    assert.equal(stored.rows.length, 1);
    await stored.append({ runId: "root", type: "run.started", payload: {} });
    assert.equal(await queries.runLinks(), before);
    await stored.append({
      runId: "child",
      type: "run.created",
      payload: { parentRunId: "root", chainId: "root" },
    });
    const origins = await queries.runOrigins();
    const after = await queries.runLinks();
    assert.deepEqual(after, {
      root: { parentRunId: null, chainId: "root", childRunIds: ["child"] },
      child: { parentRunId: "root", chainId: "root", childRunIds: [] },
    });
    assert.deepEqual(await stored.queries().runLinks(), after);
    assert.equal(await queries.runOrigins(), origins);
    assert.deepEqual(before["root"].childRunIds, []);
    assert.equal(stored.rows.length, 4);
  }));
