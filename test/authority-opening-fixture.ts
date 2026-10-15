import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { History } from "../src/authority/history.ts";
import {
  emptyAuthority,
  execute,
  type AuthorityEvent,
} from "../src/authority/reducer.ts";
import type { RestoredSnapshot } from "../src/broker/authority-restore.ts";
import {
  decisionRows,
  documentDigest,
} from "../src/broker/decision-restore.ts";
import { effectRows } from "../src/broker/effect-restore.ts";
import { referenceHistory } from "./authority-history-reference.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import { recorded } from "./authority-fixture.ts";
import { manifest, pin } from "./authority-store-fixture.ts";

export function historySnapshot(input: {
  readonly history: History;
  readonly events: readonly AuthorityEvent[];
}): RestoredSnapshot {
  const { history, events } = input;
  return {
    events: events.map((event) => ({
      ...event,
      payload: JSON.stringify(event.payload),
    })),
    definitions: [{ pin, manifest: JSON.stringify(manifest) }],
    runs: Object.values(history.state.runs).map((run) => ({
      ...run,
      gates: JSON.stringify(run.gates),
      sequence: history.runSequences[run.runId] ?? 0,
    })),
    commands: events.map(({ commandId, request, sequence }) => ({
      commandId,
      request,
      sequence,
    })),
    outbox: history.outbox,
    ...decisionRows(history.state),
    effects: effectRows(history.state.effects, history.evidence),
    documents: [{ digest: documentDigest("generated"), body: "generated" }],
  };
}

function runHistory(
  runId: string,
  sequence: number,
): readonly AuthorityEvent[] {
  let state = { ...emptyAuthority, sequence };
  const events: AuthorityEvent[] = [];
  const commands = [
    {
      kind: "admit-run",
      workflow: pin,
      effectLimit: 5,
      capabilities: '["fake-harness"]',
    },
    { kind: "mark-started", expectedRevision: 1 },
    { kind: "open-gate", expectedRevision: 2, gateId: "gate-1" },
    {
      kind: "decide-gate",
      expectedRevision: 3,
      gateId: "gate-1",
      decision: "approved",
    },
    { kind: "record-dispatch", receipt: "generated" },
    { kind: "pause-run", expectedRevision: 4 },
    { kind: "resume-run", expectedRevision: 5 },
    { kind: "pause-run", expectedRevision: 6 },
    { kind: "resume-run", expectedRevision: 7 },
    { kind: "complete-run", expectedRevision: 8 },
  ];
  for (const [index, command] of commands.entries()) {
    const result = execute(state, {
      command: {
        ...command,
        runId,
        commandId: `${runId}-${String(index)}`,
        ...(command.kind === "record-dispatch"
          ? { operationId: state.intents[0]?.operationId }
          : {}),
      },
      ...recorded,
    });
    assert.equal(result.kind, "accepted");
    state = result.state;
    events.push(...result.events);
  }
  return events;
}

function insertRows(database: DatabaseSync, snapshot: RestoredSnapshot): void {
  const tables = {
    events: snapshot.events,
    runs: snapshot.runs,
    commands: snapshot.commands,
    outbox: snapshot.outbox,
    run_details: snapshot.details ?? [],
    gates: snapshot.gates ?? [],
    run_budgets: snapshot.effects?.budgets ?? [],
  };
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const columns = Object.keys(row).map((key) =>
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      );
      const values: unknown[] = Object.values(row);
      database
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...values.map(sqlValue));
    }
  }
}

function sqlValue(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  throw new Error("unexpected-fixture-value");
}

export async function scaleDatabase(
  directory: string,
  count: number,
): Promise<void> {
  const authority = await openedAuthority(directory);
  await authority.close();
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    database.exec("BEGIN");
    database
      .prepare("INSERT INTO definitions (pin, manifest) VALUES (?, ?)")
      .run(pin, JSON.stringify(manifest));
    for (let offset = 0; offset < count; offset += 10) {
      const events = runHistory(`run-${String(offset / 10)}`, offset);
      const history = referenceHistory(events, offset);
      insertRows(database, historySnapshot({ history, events }));
    }
    database
      .prepare(
        "UPDATE solid_instances SET state = json_set(state, '$.sequence', ?)",
      )
      .run(count);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}
