import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rebuildHistory } from "../src/authority/history.ts";
import {
  emptyAuthority,
  execute,
  type AuthorityEvent,
  type AuthorityState,
} from "../src/authority/reducer.ts";
import { baselineSchema } from "../src/storage/domain-schema.ts";
import { recorded } from "./authority-fixture.ts";
import { manifest, pin } from "./authority-store-fixture.ts";

export interface Baseline {
  readonly state: AuthorityState;
  readonly events: readonly AuthorityEvent[];
}

export function baselineDatabase(
  directory: string,
  commands: readonly Readonly<Record<string, unknown>>[],
): Baseline {
  let state = emptyAuthority;
  const events: AuthorityEvent[] = [];
  for (const command of commands) {
    const result = execute(state, command, recorded);
    assert.equal(result.kind, "accepted", JSON.stringify(result));
    state = result.state;
    events.push(...result.events);
  }
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(baselineSchema);
  database
    .prepare("INSERT INTO schema_migrations (version, checksum) VALUES (1, ?)")
    .run(createHash("sha256").update(baselineSchema).digest("hex"));
  database.exec("PRAGMA user_version = 1");
  writeRows(database, { state, events });
  database.close();
  return { state, events };
}

function writeRows(database: DatabaseSync, baseline: Baseline): void {
  const { state, events } = baseline;
  const history = rebuildHistory(events);
  database
    .prepare("INSERT INTO definitions (pin, manifest) VALUES (?, ?)")
    .run(pin, JSON.stringify(manifest));
  for (const event of events)
    database
      .prepare(
        "INSERT INTO events (sequence, type, run_id, command_id, recorded_at, request, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.sequence,
        event.type,
        event.runId,
        event.commandId,
        event.recordedAt,
        event.request,
        JSON.stringify(event.payload),
      );
  for (const run of Object.values(state.runs))
    database
      .prepare(
        "INSERT INTO runs (run_id, status, revision, workflow, paused_from, gates, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.runId,
        run.status,
        run.revision,
        run.workflow,
        run.pausedFrom,
        JSON.stringify(run.gates),
        history.runSequences[run.runId] ?? 0,
      );
  for (const event of events)
    database
      .prepare(
        "INSERT INTO commands (command_id, request, sequence) VALUES (?, ?, ?)",
      )
      .run(event.commandId, event.request, event.sequence);
  for (const entry of history.outbox)
    database
      .prepare(
        "INSERT INTO outbox (operation_id, kind, run_id, created_sequence, released_sequence) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        entry.operationId,
        entry.kind,
        entry.runId,
        entry.createdSequence,
        entry.releasedSequence,
      );
}
