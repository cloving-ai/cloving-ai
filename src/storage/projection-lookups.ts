import {
  integer,
  optionalText,
  text,
  type SqlConnection,
} from "./domain-rows.ts";

export type MessageOutcome = "committed" | "rolled-back" | "missing";

const workflowColumn =
  "json_extract(s.body, '$.workflowId') AS workflow_id FROM documents s";
const workflowFilter =
  "json_valid(s.body) AND json_type(s.body, '$.workflowId') = 'text'";

export async function messageOutcomes(
  connection: SqlConnection,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, MessageOutcome>> {
  const rows = await connection.all(
    "SELECT id, completed_at_ms IS NOT NULL AND rejection IS NULL AND error IS NULL AS committed FROM solid_messages WHERE id IN (SELECT value FROM json_each(?))",
    [JSON.stringify(messageIds)],
  );
  return new Map(
    rows.map((row) => [
      text(row, "id"),
      integer(row, "committed") === 1 ? "committed" : "rolled-back",
    ]),
  );
}

export async function runTimes(
  connection: SqlConnection,
): Promise<ReadonlyMap<string, string>> {
  const rows = await connection.all(
    "SELECT r.run_id, e.recorded_at FROM runs r JOIN events e ON e.sequence = r.sequence",
  );
  return new Map(
    rows.map((row) => [text(row, "run_id"), text(row, "recorded_at")]),
  );
}

export async function recordedTimes(
  connection: SqlConnection,
  sequences: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  if (sequences.length === 0) return new Map();
  const rows = await connection.all(
    "SELECT sequence, recorded_at FROM events WHERE sequence IN (SELECT value FROM json_each(?))",
    [JSON.stringify(sequences)],
  );
  return new Map(
    rows.map((row) => [integer(row, "sequence"), text(row, "recorded_at")]),
  );
}

export async function submittedWorkflows(
  connection: SqlConnection,
): Promise<ReadonlyMap<string, string>> {
  const rows = await connection.all(
    `SELECT DISTINCT s.digest, ${workflowColumn} JOIN run_details d ON d.submission = s.digest WHERE ${workflowFilter}`,
  );
  return new Map(
    rows.map((row) => [text(row, "digest"), text(row, "workflow_id")]),
  );
}

export async function storedWorkflows(
  connection: SqlConnection,
  digests: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  if (digests.length === 0) return new Map();
  const rows = await connection.all(
    `SELECT s.digest, ${workflowColumn} WHERE s.digest IN (SELECT value FROM json_each(?)) AND ${workflowFilter}`,
    [JSON.stringify(digests)],
  );
  return new Map(
    rows.map((row) => [text(row, "digest"), optionalText(row, "workflow_id")]),
  );
}
