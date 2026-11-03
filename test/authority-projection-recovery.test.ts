import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Database, Logger } from "solid-objects";
import { sqlite } from "solid-objects/database/sqlite";
import { currentState } from "../src/broker/authority-restore.ts";
import { projectionMemory } from "../src/broker/actor/projection-memory.ts";
import { loadProjections } from "../src/storage/decision-snapshots.ts";
import type { DomainChange } from "../src/storage/domain-changes.ts";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  pin,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};

const unchanged: DomainChange = {
  previous: 0,
  sequence: 0,
  definitions: [],
  events: [],
  runs: [],
  commands: [],
  added: [],
  released: [],
  staged: [],
  closed: [],
  gates: [],
  waits: [],
  details: [],
  documents: [],
  budgets: [],
  operations: [],
  leases: [],
  evidence: [],
  stops: [],
  completesAdoption: false,
};

function recordingLogger(entries: unknown[]): Logger {
  const write = (entry: Record<string, unknown>): void => {
    entries.push(entry);
  };
  return { debug: write, info: write, warn: write, error: write };
}

async function admittedDirectory(): Promise<{
  readonly directory: string;
  readonly messageId: string;
  readonly latest: number;
}> {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await authority.close();
  const [row] = queryDatabase(
    directory,
    "SELECT id FROM solid_messages WHERE completed_at_ms IS NOT NULL AND error IS NULL AND rejection IS NULL ORDER BY completed_at_ms DESC LIMIT 1",
  );
  const [last] = queryDatabase(
    directory,
    "SELECT max(sequence) AS sequence FROM events",
  );
  return {
    directory,
    messageId: String(Reflect.get(Object(row), "id")),
    latest: Number(Reflect.get(Object(last), "sequence")),
  };
}

function failingOnce(database: Database): Pick<Database, "connection"> {
  let failed = false;
  return {
    connection: (callback) =>
      database.connection((connection) => {
        if (failed) return callback(connection);
        failed = true;
        const failure = (): Promise<never> =>
          Promise.reject(new Error("disk I/O error"));
        return callback({ ...connection, get: failure, all: failure });
      }),
  };
}

function storedRun(fields: {
  readonly runId: string;
  readonly sequence: number;
}): DomainChange["runs"][number] {
  return {
    ...fields,
    status: "paused",
    revision: 2,
    workflow: pin,
    pausedFrom: "queued",
    gates: "[]",
  };
}

const unknownSubmission = `sha256:${"0".repeat(64)}`;

const submitted: DomainChange["details"][number] = {
  runId: "run-1",
  generation: 1,
  submission: unknownSubmission,
  input: null,
  resolver: null,
  condition: null,
  reason: null,
  evidence: null,
  retryAt: null,
  attempt: null,
  attemptLimit: null,
  observedSequence: null,
  observedAt: null,
  observedOperation: null,
};

const paused =
  "UPDATE runs SET status = 'paused', paused_from = 'queued' WHERE run_id = 'run-1'";

await test("CLV-276 a recorded change that does not follow the sequence in memory makes the memory rebuild from the tables and log a warning", async () => {
  const { directory, messageId, latest } = await admittedDirectory();
  const database = sqlite({ path: join(directory, "authority.sqlite") });
  const entries: unknown[] = [];
  const memory = projectionMemory({ logger: recordingLogger(entries) });
  try {
    await memory.load(database);
    alterDatabase(directory, paused);
    memory.record({
      messageId,
      change: { ...unchanged, previous: 40, sequence: 41 },
    });
    const projection = await memory.read(database);
    assert.deepEqual(
      projection.state(),
      currentState(await database.connection(loadProjections)),
    );
    assert.equal(projection.state().runs["run-1"]?.status, "paused");
    assert.deepEqual(entries, [
      {
        event: "authority-projection-rebuilt",
        reason: `sequence 40 does not follow ${String(latest)}`,
      },
    ]);
  } finally {
    await database.close();
  }
});

await test("CLV-276 a failure of the update fails the read, and the next read rebuilds the memory from the tables", async () => {
  const { directory, messageId, latest } = await admittedDirectory();
  const database = sqlite({ path: join(directory, "authority.sqlite") });
  const entries: unknown[] = [];
  const memory = projectionMemory({ logger: recordingLogger(entries) });
  try {
    await memory.load(database);
    alterDatabase(directory, paused);
    memory.record({
      messageId,
      change: { ...unchanged, previous: latest, sequence: latest },
    });
    await assert.rejects(memory.read(failingOnce(database)), /disk I\/O error/);
    const projection = await memory.read(database);
    assert.equal(projection.state().runs["run-1"]?.status, "paused");
    assert.deepEqual(entries, [
      {
        event: "authority-projection-rebuilt",
        reason: "update failed: disk I/O error",
      },
    ]);
  } finally {
    await database.close();
  }
});

await test("CLV-276 after a failed update, the next read rebuilds the memory and does not apply again the recorded changes that the tables already hold", async () => {
  const { directory, messageId, latest } = await admittedDirectory();
  const database = sqlite({ path: join(directory, "authority.sqlite") });
  const entries: unknown[] = [];
  const memory = projectionMemory({ logger: recordingLogger(entries) });
  try {
    await memory.load(database);
    memory.record({ messageId, change: { ...unchanged, previous: latest } });
    await assert.rejects(memory.read(failingOnce(database)), /disk I\/O error/);
    memory.record({
      messageId,
      change: {
        ...unchanged,
        previous: latest,
        sequence: latest,
        runs: [storedRun({ runId: "run-9", sequence: latest })],
      },
    });
    const projection = await memory.read(database);
    assert.deepEqual(
      projection.state(),
      currentState(await database.connection(loadProjections)),
    );
    assert.equal(projection.state().runs["run-9"], undefined);
    assert.deepEqual(entries, [
      {
        event: "authority-projection-rebuilt",
        reason: "update failed: disk I/O error",
      },
    ]);
  } finally {
    await database.close();
  }
});

await test("CLV-276 more than 1000 recorded changes with no read make the memory drop them, and the next read rebuilds from the tables with no warning", async () => {
  const { directory, latest } = await admittedDirectory();
  const database = sqlite({ path: join(directory, "authority.sqlite") });
  const entries: unknown[] = [];
  const memory = projectionMemory({ logger: recordingLogger(entries) });
  try {
    await memory.load(database);
    alterDatabase(directory, paused);
    for (let index = 0; index <= 1000; index += 1)
      memory.record({
        messageId: `message-${String(index)}`,
        change: { ...unchanged, previous: latest, sequence: latest },
      });
    const projection = await memory.read(database);
    assert.equal(projection.state().runs["run-1"]?.status, "paused");
    assert.deepEqual(entries, []);
  } finally {
    await database.close();
  }
});

await test("CLV-276 a recorded change of a message that the database no longer stores makes the memory rebuild from the tables", async () => {
  const { directory, latest } = await admittedDirectory();
  const database = sqlite({ path: join(directory, "authority.sqlite") });
  const entries: unknown[] = [];
  const memory = projectionMemory({ logger: recordingLogger(entries) });
  try {
    await memory.load(database);
    alterDatabase(directory, paused);
    memory.record({
      messageId: "message-pruned",
      change: { ...unchanged, previous: latest, sequence: latest },
    });
    const projection = await memory.read(database);
    assert.equal(projection.state().runs["run-1"]?.status, "paused");
    assert.deepEqual(entries, [
      {
        event: "authority-projection-rebuilt",
        reason: "message message-pruned is not stored",
      },
    ]);
  } finally {
    await database.close();
  }
});

await test("CLV-276 a recorded change of a turn that did not commit leaves the memory unchanged", async () => {
  const { directory, messageId, latest } = await admittedDirectory();
  alterDatabase(
    directory,
    `UPDATE solid_messages SET error = '{"message":"lost"}' WHERE id = '${messageId}'`,
  );
  const database = sqlite({ path: join(directory, "authority.sqlite") });
  const entries: unknown[] = [];
  const memory = projectionMemory({ logger: recordingLogger(entries) });
  try {
    await memory.load(database);
    memory.record({
      messageId,
      change: {
        ...unchanged,
        previous: latest,
        sequence: latest,
        runs: [storedRun({ runId: "run-1", sequence: latest })],
      },
    });
    const projection = await memory.read(database);
    assert.equal(projection.state().runs["run-1"]?.status, "queued");
    assert.deepEqual(entries, []);
  } finally {
    await database.close();
  }
});

await test("CLV-276 a committed change takes run times and workflow IDs from the stored events and documents when the change does not carry them", async () => {
  const { directory, messageId, latest } = await admittedDirectory();
  const [first] = queryDatabase(
    directory,
    "SELECT recorded_at FROM events WHERE sequence = 1",
  );
  const database = sqlite({ path: join(directory, "authority.sqlite") });
  const memory = projectionMemory({ logger: recordingLogger([]) });
  try {
    await memory.load(database);
    memory.record({
      messageId,
      change: {
        ...unchanged,
        previous: latest,
        sequence: latest,
        runs: [
          storedRun({ runId: "run-1", sequence: 1 }),
          storedRun({ runId: "run-9", sequence: latest + 50 }),
        ],
        details: [submitted],
      },
    });
    const projection = await memory.read(database);
    assert.deepEqual(projection.sequences(), {
      latest,
      runs: { "run-1": 1 },
      times: { "run-1": String(Reflect.get(Object(first), "recorded_at")) },
    });
    assert.deepEqual(projection.workflowIds(), {});
    assert.equal(projection.state().runs["run-9"]?.status, "paused");
  } finally {
    await database.close();
  }
});

after(removeTemporaryDirectories);
