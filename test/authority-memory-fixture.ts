import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync, StatementSync, type SQLInputValue } from "node:sqlite";
import { eligibleIntents } from "../src/authority/reducer.ts";
import { pinnedResumption } from "../src/broker/authority-admission.ts";
import {
  currentState,
  storedDefinitions,
} from "../src/broker/authority-restore.ts";
import type { Authority } from "../src/broker/actor/authority.ts";
import { authorityQueries } from "../src/broker/actor/authority-queries.ts";
import { operationRecords } from "../src/broker/actor/authority-session.ts";
import { loadProjections } from "../src/storage/decision-snapshots.ts";
import type { SqlConnection } from "../src/storage/domain-rows.ts";
import { deliverUntil } from "./authority-actor-fixture.ts";
import { manifest, storedGate } from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectRequest,
  sender,
  type Clock,
  type Send,
} from "./effect-fixture.ts";

const projectedTables =
  /\b(?:FROM|JOIN) (?:definitions|runs|commands|outbox|gates|run_details|command_waits|deliveries|dispatch_attempts|operations|documents)\b/;

export function fullReads(statements: readonly string[]): readonly string[] {
  return statements.filter(
    (sql) =>
      sql.trimStart().startsWith("SELECT") &&
      projectedTables.test(sql) &&
      !sql.includes("?"),
  );
}

export async function preparedDuring(
  action: () => Promise<unknown>,
): Promise<readonly string[]> {
  const descriptor = Object.getOwnPropertyDescriptor(
    DatabaseSync.prototype,
    "prepare",
  );
  assert.ok(descriptor);
  const prepare: unknown = descriptor.value;
  assert.equal(typeof prepare, "function");
  const statements: string[] = [];
  DatabaseSync.prototype.prepare = function (sql) {
    statements.push(sql);
    assert.ok(typeof prepare === "function");
    const statement: unknown = Reflect.apply(prepare, this, [sql]);
    assert.ok(statement instanceof StatementSync);
    return statement;
  };
  try {
    await action();
  } finally {
    Object.defineProperty(DatabaseSync.prototype, "prepare", descriptor);
  }
  return statements;
}

function submissionOf(runId: string): string {
  return JSON.stringify({
    workflowId: "develop",
    submission: { prompt: `task of ${runId}` },
  });
}

async function accepted(
  send: Send,
  input: {
    readonly command: Readonly<Record<string, unknown>>;
    readonly documents?: readonly string[];
  },
): Promise<void> {
  const receipt = await send(input.command, input.documents);
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
}

async function admitted(send: Send, runId: string): Promise<void> {
  const submission = submissionOf(runId);
  const executionInput = `input of ${runId}`;
  await accepted(send, {
    command: {
      ...storedGate[0],
      runId,
      commandId: `c-admit-${runId}`,
      submission: digestOf(submission),
      input: digestOf(executionInput),
      resolver: "fake-resolver:1",
      effectLimit: 5,
      capabilities: JSON.stringify([...manifest.capabilities].sort()),
    },
    documents: [submission, executionInput],
  });
}

function revised(fields: {
  readonly kind: string;
  readonly runId: string;
  readonly expectedRevision: number;
}): { readonly command: Readonly<Record<string, unknown>> } {
  return {
    command: {
      ...fields,
      commandId: `c-${fields.kind}-${fields.runId}-${String(fields.expectedRevision)}`,
    },
  };
}

async function decided(send: Send): Promise<void> {
  await accepted(
    send,
    revised({ kind: "mark-started", runId: "run-1", expectedRevision: 1 }),
  );
  await accepted(send, {
    command: {
      kind: "open-gate",
      commandId: "c-gate-run-1",
      runId: "run-1",
      gateId: "gate-1",
      expectedRevision: 2,
    },
  });
  await accepted(send, {
    command: {
      kind: "decide-gate",
      commandId: "c-decide-run-1",
      runId: "run-1",
      gateId: "gate-1",
      decision: "approved",
      expectedRevision: 3,
    },
  });
}

async function effected(send: Send): Promise<void> {
  const request = effectRequest({ commandId: "c-effect-run-1", round: 1 });
  await accepted(send, request);
  await accepted(send, {
    command: {
      kind: "report-observation",
      commandId: "c-observe-run-1",
      runId: "run-1",
      condition: "working",
      reason: "progress",
    },
  });
}

async function settled(authority: Authority): Promise<void> {
  await deliverUntil(authority, async () => {
    const open = (await authority.operations()).flatMap((operation) =>
      operation.deliveries.filter((delivery) => delivery.outcome === null),
    );
    return (
      (await authority.eligibleIntents()).length === 0 && open.length === 0
    );
  });
}

export async function scriptedSeries(authority: Authority): Promise<void> {
  const clock: Clock = { now: "2026-10-10T12:00:00.000Z" };
  const send = sender(authority, clock);
  await admitted(send, "run-1");
  await settled(authority);
  await decided(send);
  await settled(authority);
  await effected(send);
  await settled(authority);
  await admitted(send, "run-2");
  await accepted(
    send,
    revised({ kind: "cancel-run", runId: "run-2", expectedRevision: 1 }),
  );
  await admitted(send, "run-3");
  await accepted(
    send,
    revised({ kind: "pause-run", runId: "run-3", expectedRevision: 1 }),
  );
  await accepted(
    send,
    revised({ kind: "resume-run", runId: "run-3", expectedRevision: 2 }),
  );
  await settled(authority);
}

export async function admittedBatch(
  authority: Authority,
  runIds: readonly string[],
): Promise<void> {
  const send = sender(authority, { now: "2026-10-10T12:00:00.000Z" });
  for (const runId of runIds) await admitted(send, runId);
}

export async function memoryReads(authority: Authority): Promise<unknown> {
  return {
    state: await authority.state(),
    eligible: await authority.eligibleIntents(),
    operations: await authority.operations(),
    resumption: await authority.resumePinned("run-1", manifest),
    sequences: await authority.queries.sequences(),
    workflowIds: await authority.queries.workflowIds(),
    scopedWorkflowIds: await authority.queries.workflowIds(["run-2"]),
  };
}

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

function readOnly(database: DatabaseSync): SqlConnection {
  const rows = (
    sql: string,
    parameters: readonly unknown[] = [],
  ): readonly unknown[] =>
    database.prepare(sql).all(...parameters.map(sqlValue));
  return {
    run: () => Promise.reject(new Error("read-only")),
    get: (sql, parameters) => Promise.resolve(rows(sql, parameters)[0]),
    all: (sql, parameters) => Promise.resolve(rows(sql, parameters)),
  };
}

export async function rebuiltReads(directory: string): Promise<unknown> {
  const database = new DatabaseSync(join(directory, "authority.sqlite"), {
    readOnly: true,
  });
  try {
    const connection = readOnly(database);
    const snapshot = await loadProjections(connection);
    const state = currentState(snapshot);
    const queries = authorityQueries((query) => query(connection));
    return {
      state,
      eligible: eligibleIntents({
        ...state,
        effects: {
          operations: Object.fromEntries(
            snapshot.pending.map((id) => [id, { status: "dispatch-pending" }]),
          ),
        },
      }),
      operations: operationRecords(snapshot),
      resumption: pinnedResumption(state, {
        definitions: storedDefinitions(snapshot),
        runId: "run-1",
        available: manifest,
      }),
      sequences: await queries.sequences(),
      workflowIds: await queries.workflowIds(),
      scopedWorkflowIds: await queries.workflowIds(["run-2"]),
    };
  } finally {
    database.close();
  }
}
