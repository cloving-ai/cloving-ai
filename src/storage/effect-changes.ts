import type { SqlConnection } from "./domain-rows.ts";
import {
  budgetColumns,
  evidenceColumns,
  leaseColumns,
  operationColumns,
  stopColumns,
  type BudgetRow,
  type EffectRows,
  type EvidenceRow,
  type LeaseRow,
  type OperationRow,
  type StopRow,
} from "./effect-rows.ts";
import { upsert, type Statement } from "./statements.ts";

const budgetUpsert = upsert({
  table: "run_budgets",
  names: budgetColumns.split(", "),
  key: 1,
});

const operationUpsert = upsert({
  table: "operations",
  names: operationColumns.split(", "),
  key: 1,
});

const leaseUpsert = upsert({
  table: "leases",
  names: leaseColumns.split(", "),
  key: 1,
});

const stopUpsert = upsert({
  table: "stopped_operations",
  names: stopColumns.split(", "),
  key: 1,
});

const evidenceInsert = `INSERT INTO effect_evidence (${evidenceColumns}) VALUES (?, ?, ?, ?, ?)`;

function budgetParameters(row: BudgetRow): readonly unknown[] {
  return [
    row.runId,
    row.effectLimit,
    row.spent,
    row.capabilities,
    row.exhaustedSequence,
  ];
}

function operationParameters(row: OperationRow): readonly unknown[] {
  return [
    row.operationId,
    row.runId,
    row.capability,
    row.method,
    row.target,
    row.payload,
    row.inputDigest,
    row.units,
    row.leaseKey,
    row.recoveryLimit,
    row.status,
    row.reason,
    row.attempts,
    row.receipt,
    row.worker,
    row.result,
    row.requestedSequence,
    row.waitSequence,
    row.settledSequence,
  ];
}

function leaseParameters(row: LeaseRow): readonly unknown[] {
  return [
    row.resourceKey,
    row.operationId,
    row.generation,
    row.expiresAt,
    row.state,
    row.grantedSequence,
  ];
}

function evidenceParameters(row: EvidenceRow): readonly unknown[] {
  return [
    row.sequence,
    row.runId,
    row.operationId,
    row.disposition,
    row.reason,
  ];
}

function stopParameters(row: StopRow): readonly unknown[] {
  return [row.operationId, row.runId, row.sequence];
}

export function effectStatements(rows: EffectRows): readonly Statement[] {
  return [
    ...rows.budgets.map((row) => ({
      sql: budgetUpsert,
      parameters: budgetParameters(row),
    })),
    ...rows.operations.map((row) => ({
      sql: operationUpsert,
      parameters: operationParameters(row),
    })),
    ...rows.leases.map((row) => ({
      sql: leaseUpsert,
      parameters: leaseParameters(row),
    })),
    ...rows.evidence.map((row) => ({
      sql: evidenceInsert,
      parameters: evidenceParameters(row),
    })),
    ...rows.stops.map((row) => ({
      sql: stopUpsert,
      parameters: stopParameters(row),
    })),
  ];
}

export async function persistEffects(
  connection: SqlConnection,
  rows: EffectRows,
): Promise<void> {
  for (const statement of effectStatements(rows))
    await connection.run(statement.sql, statement.parameters);
}
