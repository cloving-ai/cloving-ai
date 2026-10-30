import {
  integer,
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "./domain-rows.ts";
import { upsert, type Statement } from "./statements.ts";

export const commandWaitSchema = `
CREATE TABLE command_waits (
  run_id TEXT NOT NULL REFERENCES runs (run_id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  input_digest TEXT NOT NULL REFERENCES documents (digest) DEFERRABLE INITIALLY DEFERRED,
  maximum_wait_seconds INTEGER NOT NULL,
  poll_every_seconds INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  next_check_at INTEGER,
  state TEXT NOT NULL,
  settled_at INTEGER,
  reason TEXT,
  PRIMARY KEY (run_id, name)
) STRICT;
`;

export const commandWaitCheckSchema = `
ALTER TABLE command_waits ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE command_waits ADD COLUMN check_operation TEXT;
ALTER TABLE command_waits ADD COLUMN last_check_settled_at INTEGER;
ALTER TABLE command_waits ADD COLUMN result TEXT;
`;

export interface CommandWaitRow {
  readonly runId: string;
  readonly name: string;
  readonly command: string;
  readonly inputDigest: string;
  readonly maximumWaitSeconds: number;
  readonly pollEverySeconds: number;
  readonly startedAt: number;
  readonly deadline: number;
  readonly nextCheckAt: number | null;
  readonly state: string;
  readonly checkCount: number;
  readonly checkOperation: string | null;
  readonly lastCheckSettledAt: number | null;
  readonly result: string | null;
  readonly settledAt: number | null;
  readonly reason: string | null;
}

const openingColumns =
  "run_id, name, command, input_digest, maximum_wait_seconds, poll_every_seconds, started_at, deadline, next_check_at, state, settled_at, reason";
const checkColumns =
  "check_count, check_operation, last_check_settled_at, result";
const columns = `${openingColumns}, ${checkColumns}`;
const save = upsert({
  table: "command_waits",
  names: columns.split(", "),
  key: 2,
});

export function commandWaitRow(value: unknown): CommandWaitRow {
  return {
    runId: text(value, "run_id"),
    name: text(value, "name"),
    command: text(value, "command"),
    inputDigest: text(value, "input_digest"),
    maximumWaitSeconds: integer(value, "maximum_wait_seconds"),
    pollEverySeconds: integer(value, "poll_every_seconds"),
    startedAt: integer(value, "started_at"),
    deadline: integer(value, "deadline"),
    nextCheckAt: optionalInteger(value, "next_check_at"),
    state: text(value, "state"),
    checkCount: integer(value, "check_count"),
    checkOperation: optionalText(value, "check_operation"),
    lastCheckSettledAt: optionalInteger(value, "last_check_settled_at"),
    result: optionalText(value, "result"),
    settledAt: optionalInteger(value, "settled_at"),
    reason: optionalText(value, "reason"),
  };
}

export async function loadCommandWaits(
  connection: SqlConnection,
  scope: { readonly runId?: string; readonly version?: "opened" } = {},
): Promise<readonly CommandWaitRow[]> {
  const { runId } = scope;
  const selected =
    scope.version === "opened"
      ? `${openingColumns}, 0 AS check_count, NULL AS check_operation, NULL AS last_check_settled_at, NULL AS result`
      : columns;
  const rows = await connection.all(
    `SELECT ${selected} FROM command_waits` +
      (runId === undefined ? "" : " WHERE run_id = ?") +
      " ORDER BY run_id, name",
    runId === undefined ? [] : [runId],
  );
  return rows.map(commandWaitRow);
}

export function commandWaitStatements(
  rows: readonly CommandWaitRow[],
  scope: { readonly version?: "opened" } = {},
): readonly Statement[] {
  return rows.map((row) => ({
    sql:
      scope.version === "opened"
        ? upsert({
            table: "command_waits",
            names: openingColumns.split(", "),
            key: 2,
          })
        : save,
    parameters: [
      row.runId,
      row.name,
      row.command,
      row.inputDigest,
      row.maximumWaitSeconds,
      row.pollEverySeconds,
      row.startedAt,
      row.deadline,
      row.nextCheckAt,
      row.state,
      row.settledAt,
      row.reason,
      ...(scope.version === "opened"
        ? []
        : [
            row.checkCount,
            row.checkOperation,
            row.lastCheckSettledAt,
            row.result,
          ]),
    ],
  }));
}
