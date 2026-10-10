import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { after, test } from "node:test";
import {
  projectedState,
  restore,
  storedDefinitions,
  storedEvents,
} from "../src/broker/authority-restore.ts";
import {
  loadEvents,
  loadProjections,
  loadSnapshot,
  type SqlConnection,
} from "../src/storage/domain-rows.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};

function sqlValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  )
    return value;
  throw new Error("unsupported-parameter");
}

function recordingConnection(source: {
  readonly database: DatabaseSync;
  readonly statements: string[];
}): SqlConnection {
  const { database, statements } = source;
  const rows = (
    sql: string,
    parameters: readonly unknown[] = [],
  ): readonly unknown[] => {
    statements.push(sql);
    return database.prepare(sql).all(...parameters.map(sqlValue));
  };
  return {
    run: () => Promise.reject(new Error("read-only")),
    get: (sql, parameters) => Promise.resolve(rows(sql, parameters)[0]),
    all: (sql, parameters) => Promise.resolve(rows(sql, parameters)),
  };
}

async function recordedHistory(directory: string): Promise<void> {
  const service = externalService();
  const authority = await openedAuthority(directory, service.options);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  for (const command of [
    ...storedGate.slice(1),
    { ...admission, commandId: "c-5", runId: "run-2" },
  ])
    assert.equal((await executePinned(authority, command)).kind, "accepted");
  await authority.close();
}

await test("CLV-042 a projection read gives the replayed state, events and definitions and reads no event rows except the latest sequence", async () => {
  const directory = await temporaryDirectory();
  await recordedHistory(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"), {
    readOnly: true,
  });
  try {
    const replayed = restore(
      await loadSnapshot(recordingConnection({ database, statements: [] })),
    );
    assert.equal(replayed.kind, "restored");
    const statements: string[] = [];
    const projections = await loadProjections(
      recordingConnection({ database, statements }),
    );
    assert.deepEqual(projectedState(projections), replayed.state);
    assert.deepEqual(storedDefinitions(projections), replayed.definitions);
    assert.deepEqual(
      statements.filter((sql) => /\bevents\b/.test(sql)),
      ["SELECT coalesce(max(sequence), 0) AS sequence FROM events"],
    );
    assert.deepEqual(
      storedEvents(
        await loadEvents(recordingConnection({ database, statements: [] })),
      ),
      replayed.events,
    );
    assert.equal(Object.keys(replayed.state.runs).length, 2);
    assert.equal(replayed.state.intents.length, 2);
  } finally {
    database.close();
  }
});

after(removeTemporaryDirectories);
