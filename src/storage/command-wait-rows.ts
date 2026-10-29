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
  readonly settledAt: number | null;
  readonly reason: string | null;
}

const columns =
  "run_id, name, command, input_digest, maximum_wait_seconds, poll_every_seconds, started_at, deadline, next_check_at, state, settled_at, reason";
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
    settledAt: optionalInteger(value, "settled_at"),
    reason: optionalText(value, "reason"),
  };
}

export async function loadCommandWaits(
  connection: SqlConnection,
  runId?: string,
): Promise<readonly CommandWaitRow[]> {
  const rows = await connection.all(
    `SELECT ${columns} FROM command_waits` +
      (runId === undefined ? "" : " WHERE run_id = ?") +
      " ORDER BY run_id, name",
    runId === undefined ? [] : [runId],
  );
  return rows.map(commandWaitRow);
}

export function commandWaitStatements(
  rows: readonly CommandWaitRow[],
): readonly Statement[] {
  return rows.map((row) => ({
    sql: save,
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
    ],
  }));
}
