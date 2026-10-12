import {
  integer,
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "./domain-rows.ts";

export interface BudgetRow {
  readonly runId: string;
  readonly effectLimit: number;
  readonly spent: number;
  readonly capabilities: string;
  readonly exhaustedSequence: number | null;
}

export interface OperationRow {
  readonly operationId: string;
  readonly runId: string;
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  readonly payload: string;
  readonly inputDigest: string;
  readonly units: number;
  readonly leaseKey: string;
  readonly recoveryLimit: number;
  readonly status: string;
  readonly reason: string | null;
  readonly attempts: number;
  readonly receipt: string | null;
  readonly worker: string | null;
  readonly result: string | null;
  readonly requestedSequence: number;
  readonly waitSequence: number | null;
  readonly settledSequence: number | null;
}

export interface LeaseRow {
  readonly resourceKey: string;
  readonly operationId: string;
  readonly generation: number;
  readonly expiresAt: string;
  readonly state: string;
  readonly grantedSequence: number;
}

export interface EvidenceRow {
  readonly sequence: number;
  readonly runId: string;
  readonly operationId: string;
  readonly disposition: string;
  readonly reason: string | null;
}

export interface StopRow {
  readonly operationId: string;
  readonly runId: string;
  readonly sequence: number;
}

export interface EffectRows {
  readonly budgets: readonly BudgetRow[];
  readonly operations: readonly OperationRow[];
  readonly leases: readonly LeaseRow[];
  readonly evidence: readonly EvidenceRow[];
  readonly stops: readonly StopRow[];
}

export const budgetColumns =
  "run_id, effect_limit, spent, capabilities, exhausted_sequence";

export const operationColumns =
  "operation_id, run_id, capability, method, target, payload, input_digest, units, lease_key, recovery_limit, status, reason, attempts, receipt, worker, result, requested_sequence, wait_sequence, settled_sequence";

export const leaseColumns =
  "resource_key, operation_id, generation, expires_at, state, granted_sequence";

export const evidenceColumns =
  "sequence, run_id, operation_id, disposition, reason";

export const stopColumns = "operation_id, run_id, sequence";

export function budgetRow(row: unknown): BudgetRow {
  return {
    runId: text(row, "run_id"),
    effectLimit: integer(row, "effect_limit"),
    spent: integer(row, "spent"),
    capabilities: text(row, "capabilities"),
    exhaustedSequence: optionalInteger(row, "exhausted_sequence"),
  };
}

export function operationRow(row: unknown): OperationRow {
  return {
    operationId: text(row, "operation_id"),
    runId: text(row, "run_id"),
    capability: text(row, "capability"),
    method: text(row, "method"),
    target: text(row, "target"),
    payload: text(row, "payload"),
    inputDigest: text(row, "input_digest"),
    units: integer(row, "units"),
    leaseKey: text(row, "lease_key"),
    recoveryLimit: integer(row, "recovery_limit"),
    status: text(row, "status"),
    reason: optionalText(row, "reason"),
    attempts: integer(row, "attempts"),
    receipt: optionalText(row, "receipt"),
    worker: optionalText(row, "worker"),
    result: optionalText(row, "result"),
    requestedSequence: integer(row, "requested_sequence"),
    waitSequence: optionalInteger(row, "wait_sequence"),
    settledSequence: optionalInteger(row, "settled_sequence"),
  };
}

export function leaseRow(row: unknown): LeaseRow {
  return {
    resourceKey: text(row, "resource_key"),
    operationId: text(row, "operation_id"),
    generation: integer(row, "generation"),
    expiresAt: text(row, "expires_at"),
    state: text(row, "state"),
    grantedSequence: integer(row, "granted_sequence"),
  };
}

export function evidenceRow(row: unknown): EvidenceRow {
  return {
    sequence: integer(row, "sequence"),
    runId: text(row, "run_id"),
    operationId: text(row, "operation_id"),
    disposition: text(row, "disposition"),
    reason: optionalText(row, "reason"),
  };
}

export function stopRow(row: unknown): StopRow {
  return {
    operationId: text(row, "operation_id"),
    runId: text(row, "run_id"),
    sequence: integer(row, "sequence"),
  };
}

export async function loadEffects(
  connection: SqlConnection,
): Promise<EffectRows> {
  const rows = (sql: string): Promise<readonly unknown[]> =>
    connection.all(sql);
  return {
    budgets: (
      await rows(`SELECT ${budgetColumns} FROM run_budgets ORDER BY run_id`)
    ).map(budgetRow),
    operations: (
      await rows(
        `SELECT ${operationColumns} FROM operations ORDER BY requested_sequence, operation_id`,
      )
    ).map(operationRow),
    leases: (
      await rows(`SELECT ${leaseColumns} FROM leases ORDER BY resource_key`)
    ).map(leaseRow),
    evidence: (
      await rows(
        `SELECT ${evidenceColumns} FROM effect_evidence ORDER BY sequence`,
      )
    ).map(evidenceRow),
    stops: (
      await rows(
        `SELECT ${stopColumns} FROM stopped_operations ORDER BY operation_id`,
      )
    ).map(stopRow),
  };
}
