import type { DatabaseSync } from "node:sqlite";

export interface EventRow {
  readonly sequence: number;
  readonly type: string;
  readonly runId: string;
  readonly commandId: string;
  readonly recordedAt: string;
  readonly request: string;
  readonly payload: string;
}

export interface RunRow {
  readonly runId: string;
  readonly status: string;
  readonly revision: number;
  readonly workflow: string;
  readonly pausedFrom: string | null;
  readonly gates: string;
  readonly sequence: number;
}

export interface CommandRow {
  readonly commandId: string;
  readonly request: string;
  readonly sequence: number;
}

export interface IntentRow {
  readonly operationId: string;
  readonly kind: string;
  readonly runId: string;
  readonly createdSequence: number;
}

export interface OutboxRow extends IntentRow {
  readonly releasedSequence: number | null;
}

export interface DefinitionRow {
  readonly pin: string;
  readonly manifest: string;
}

export interface AuthoritySnapshot {
  readonly definitions: readonly DefinitionRow[];
  readonly events: readonly EventRow[];
  readonly runs: readonly RunRow[];
  readonly commands: readonly CommandRow[];
  readonly outbox: readonly OutboxRow[];
}

export function load(database: DatabaseSync): AuthoritySnapshot {
  return {
    definitions: database
      .prepare("SELECT pin, manifest FROM definitions ORDER BY pin")
      .all()
      .map((row) => ({
        pin: text(row, "pin"),
        manifest: text(row, "manifest"),
      })),
    events: database
      .prepare(
        "SELECT sequence, type, run_id, command_id, recorded_at, request, payload FROM events ORDER BY sequence",
      )
      .all()
      .map((row) => ({
        sequence: integer(row, "sequence"),
        type: text(row, "type"),
        runId: text(row, "run_id"),
        commandId: text(row, "command_id"),
        recordedAt: text(row, "recorded_at"),
        request: text(row, "request"),
        payload: text(row, "payload"),
      })),
    runs: database
      .prepare(
        "SELECT run_id, status, revision, workflow, paused_from, gates, sequence FROM runs ORDER BY run_id",
      )
      .all()
      .map((row) => ({
        runId: text(row, "run_id"),
        status: text(row, "status"),
        revision: integer(row, "revision"),
        workflow: text(row, "workflow"),
        pausedFrom: optionalText(row, "paused_from"),
        gates: text(row, "gates"),
        sequence: integer(row, "sequence"),
      })),
    commands: database
      .prepare(
        "SELECT command_id, request, sequence FROM commands ORDER BY sequence",
      )
      .all()
      .map((row) => ({
        commandId: text(row, "command_id"),
        request: text(row, "request"),
        sequence: integer(row, "sequence"),
      })),
    outbox: loadOutbox(database),
  };
}

function loadOutbox(database: DatabaseSync): readonly OutboxRow[] {
  return database
    .prepare(
      "SELECT operation_id, kind, run_id, created_sequence, released_sequence FROM outbox ORDER BY created_sequence, rowid",
    )
    .all()
    .map((row) => ({
      operationId: text(row, "operation_id"),
      kind: text(row, "kind"),
      runId: text(row, "run_id"),
      createdSequence: integer(row, "created_sequence"),
      releasedSequence: column(row, "released_sequence", isOptionalInteger),
    }));
}

function column<Value>(
  row: unknown,
  name: string,
  accepts: (value: unknown) => value is Value,
): Value {
  const value: unknown = Reflect.get(Object(row), name);
  if (!accepts(value)) throw new Error(`invalid-column: ${name}`);
  return value;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

export function text(row: unknown, name: string): string {
  return column(row, name, isText);
}

export function optionalText(row: unknown, name: string): string | null {
  return column(row, name, isOptionalText);
}

export function integer(row: unknown, name: string): number {
  return column(row, name, isInteger);
}
