import type { Evidence, RunBudget } from "../../authority/operations.ts";
import { runClosure, type RunClosure } from "../../authority/stop-sequence.ts";
import {
  integer,
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import {
  budgetColumns,
  budgetRow,
  evidenceColumns,
  evidenceRow,
  operationColumns,
  operationRow,
  type OperationRow,
} from "../../storage/effect-rows.ts";
import { storedBudget } from "../effect-restore.ts";
import type { Read } from "./authority-queries.ts";
import { stopping } from "./stop-turn.ts";

export interface OperationView extends OperationRow {
  readonly leaseGeneration: number | null;
  readonly waitCause: string | null;
}

export type StoredDisposition = Omit<Evidence, "sequence">;

export interface EffectQueries {
  readonly operation: (
    operationId: string,
  ) => Promise<OperationView | undefined>;
  readonly operations: (runId: string) => Promise<readonly OperationView[]>;
  readonly evidence: (runId: string) => Promise<readonly number[]>;
  readonly disposition: (
    sequence: number,
  ) => Promise<StoredDisposition | undefined>;
  readonly budget: (runId: string) => Promise<RunBudget | undefined>;
  readonly dueLeases: (instant: string) => Promise<readonly DueLease[]>;
  readonly stops: (runId: string) => Promise<readonly string[]>;
  readonly closure: (runId: string) => Promise<RunClosure>;
}

async function storedClosure(
  connection: SqlConnection,
  scope: { readonly runId: string; readonly stopLimit: number },
): Promise<RunClosure> {
  const { subjects, cancelledSequence } = await stopping(
    connection,
    scope.runId,
  );
  return runClosure(subjects, {
    cancelledSequence: cancelledSequence ?? 0,
    stopLimit: scope.stopLimit,
  });
}

async function stops(
  connection: SqlConnection,
  runId: string,
): Promise<readonly string[]> {
  const rows = await connection.all(
    "SELECT operation_id FROM stopped_operations WHERE run_id = ? ORDER BY operation_id",
    [runId],
  );
  return rows.map((row) => text(row, "operation_id"));
}

export interface DueLease {
  readonly runId: string;
  readonly operationId: string;
  readonly generation: number;
}

const dueBatch = 100;

async function dueLeases(
  connection: SqlConnection,
  instant: string,
): Promise<readonly DueLease[]> {
  const rows = await connection.all(
    "SELECT o.run_id, l.operation_id, l.generation FROM leases l JOIN operations o ON o.operation_id = l.operation_id WHERE l.state = 'held' AND l.expires_at <= ? ORDER BY l.expires_at, l.resource_key LIMIT ?",
    [new Date(instant).toISOString(), dueBatch],
  );
  return rows.map((row) => ({
    runId: text(row, "run_id"),
    operationId: text(row, "operation_id"),
    generation: integer(row, "generation"),
  }));
}

const viewColumns = operationColumns
  .split(", ")
  .map((name) => `o.${name}`)
  .join(", ");

const waitCause =
  "CASE WHEN o.status != 'waiting' THEN NULL WHEN r.status != 'running' THEN 'run-not-running' WHEN EXISTS (SELECT 1 FROM leases h WHERE h.resource_key = o.lease_key AND h.state != 'released') THEN 'resource' ELSE 'ready' END";

const viewed = `SELECT ${viewColumns}, l.generation AS lease_generation, ${waitCause} AS wait_cause FROM operations o JOIN runs r ON r.run_id = o.run_id LEFT JOIN leases l ON l.resource_key = o.lease_key AND l.operation_id = o.operation_id AND l.state != 'released'`;

function operationView(row: unknown): OperationView {
  return {
    ...operationRow(row),
    leaseGeneration: optionalInteger(row, "lease_generation"),
    waitCause: optionalText(row, "wait_cause"),
  };
}

async function operation(
  connection: SqlConnection,
  operationId: string,
): Promise<OperationView | undefined> {
  const row = await connection.get(`${viewed} WHERE o.operation_id = ?`, [
    operationId,
  ]);
  return row === undefined ? undefined : operationView(row);
}

async function operations(
  connection: SqlConnection,
  runId: string,
): Promise<readonly OperationView[]> {
  const rows = await connection.all(
    `${viewed} WHERE o.run_id = ? ORDER BY o.requested_sequence`,
    [runId],
  );
  return rows.map(operationView);
}

async function evidence(
  connection: SqlConnection,
  runId: string,
): Promise<readonly number[]> {
  const rows = await connection.all(
    "SELECT e.sequence FROM effect_evidence e JOIN events v ON v.sequence = e.sequence WHERE e.run_id = ? AND (e.disposition IN ('rejected', 'denied', 'refused') OR (v.type = 'operation.reconciled' AND json_extract(v.payload, '$.outcome') = 'unknown')) ORDER BY e.sequence",
    [runId],
  );
  return rows.map((row) => integer(row, "sequence"));
}

async function disposition(
  connection: SqlConnection,
  sequence: number,
): Promise<StoredDisposition | undefined> {
  const row = await connection.get(
    `SELECT ${evidenceColumns} FROM effect_evidence WHERE sequence = ?`,
    [sequence],
  );
  if (row === undefined) return undefined;
  const stored = evidenceRow(row);
  return {
    runId: stored.runId,
    operationId: stored.operationId,
    disposition: stored.disposition,
    reason: stored.reason,
  };
}

async function budget(
  connection: SqlConnection,
  runId: string,
): Promise<RunBudget | undefined> {
  const row = await connection.get(
    `SELECT ${budgetColumns} FROM run_budgets WHERE run_id = ?`,
    [runId],
  );
  return row === undefined ? undefined : storedBudget(budgetRow(row));
}

export function effectQueries(
  read: Read,
  settings: { readonly stopLimit: number },
): EffectQueries {
  return {
    stops: (runId) => read((connection) => stops(connection, runId)),
    closure: (runId) =>
      read((connection) =>
        storedClosure(connection, { runId, stopLimit: settings.stopLimit }),
      ),
    budget: (runId) => read((connection) => budget(connection, runId)),
    dueLeases: (instant) =>
      read((connection) => dueLeases(connection, instant)),
    operation: (operationId) =>
      read((connection) => operation(connection, operationId)),
    operations: (runId) => read((connection) => operations(connection, runId)),
    evidence: (runId) => read((connection) => evidence(connection, runId)),
    disposition: (sequence) =>
      read((connection) => disposition(connection, sequence)),
  };
}
