import { readCommandWaitDeadline } from "../command-wait-restore.ts";
import type { RunDetails } from "../../authority/details.ts";
import type { EffectState } from "../../authority/operations.ts";
import type { EffectIntent, RunState } from "../../authority/reducer.ts";
import { detailColumns, detailRow } from "../../storage/decision-rows.ts";
import {
  integer,
  runRow,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { storedRun } from "../authority-restore.ts";
import { storedDetails } from "../decision-restore.ts";
import {
  budgetColumns,
  budgetRow,
  leaseColumns,
  leaseRow,
  operationColumns,
  operationRow,
  type LeaseRow,
  type OperationRow,
} from "../../storage/effect-rows.ts";
import { storedEffects } from "../effect-restore.ts";
import type {
  DeliveryIntent,
  Purpose,
  Undigested,
} from "./delivery-intents.ts";

export interface EffectScope {
  readonly runId: string;
  readonly operations: readonly string[];
  readonly keys: readonly string[];
  readonly capacity: number;
}

const candidateColumns = operationColumns
  .split(", ")
  .map((name) => `p.${name}`)
  .join(", ");

const oldestElsewhere =
  "p.status = 'waiting' AND r.status = 'running' AND p.run_id != ? AND NOT EXISTS (SELECT 1 FROM operations q JOIN runs s ON s.run_id = q.run_id WHERE q.lease_key = p.lease_key AND q.status = 'waiting' AND s.status = 'running' AND q.run_id != ? AND q.wait_sequence < p.wait_sequence)";

async function candidates(
  connection: SqlConnection,
  scope: EffectScope,
): Promise<readonly unknown[]> {
  const { runId, capacity } = scope;
  const source = `SELECT ${candidateColumns} FROM operations p JOIN runs r ON r.run_id = p.run_id WHERE ${oldestElsewhere}`;
  return [
    ...(await connection.all(
      `${source} AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.resource_key = p.lease_key AND l.state != 'released') ORDER BY p.wait_sequence LIMIT ?`,
      [runId, runId, capacity],
    )),
    ...(await connection.all(
      `${source} AND p.lease_key IN (SELECT l.resource_key FROM leases l JOIN operations o ON o.operation_id = l.operation_id WHERE o.run_id = ? AND l.state != 'released') ORDER BY p.wait_sequence`,
      [runId, runId, runId],
    )),
  ];
}

const open =
  "status NOT IN ('refused', 'completed', 'failed', 'stopped', 'cancelled')";

async function operations(
  connection: SqlConnection,
  scope: EffectScope,
): Promise<readonly OperationRow[]> {
  const rows = [
    ...(await connection.all(
      `SELECT ${operationColumns} FROM operations WHERE run_id = ? AND ${open} ORDER BY requested_sequence`,
      [scope.runId],
    )),
  ];
  for (const operationId of scope.operations)
    rows.push(
      ...(await connection.all(
        `SELECT ${operationColumns} FROM operations WHERE operation_id = ?`,
        [operationId],
      )),
    );
  rows.push(...(await candidates(connection, scope)));
  return [
    ...new Map(
      rows.map(operationRow).map((row) => [row.operationId, row]),
    ).values(),
  ];
}

async function leases(
  connection: SqlConnection,
  keys: readonly string[],
): Promise<readonly LeaseRow[]> {
  const rows: unknown[] = [];
  for (const key of new Set(keys))
    rows.push(
      ...(await connection.all(
        `SELECT ${leaseColumns} FROM leases WHERE resource_key = ?`,
        [key],
      )),
    );
  return rows.map(leaseRow);
}

export async function effectTurn(
  connection: SqlConnection,
  scope: EffectScope,
): Promise<EffectState> {
  const loaded = await operations(connection, scope);
  const budgets: unknown[] = [];
  for (const runId of new Set([scope.runId, ...loaded.map((row) => row.runId)]))
    budgets.push(
      ...(await connection.all(
        `SELECT ${budgetColumns} FROM run_budgets WHERE run_id = ?`,
        [runId],
      )),
    );
  return storedEffects({
    budgets: budgets.map(budgetRow),
    operations: loaded,
    leases: await leases(connection, [
      ...loaded.map((row) => row.leaseKey),
      ...scope.keys,
    ]),
    stops: [],
    holding: integer(
      await connection.get(
        "SELECT count(*) AS holding FROM operations WHERE status IN ('dispatch-pending', 'running', 'recovering', 'blocked')",
      ),
      "holding",
    ),
  });
}

export async function pendingEffect(
  connection: SqlConnection,
  attempt: { readonly intent: Undigested; readonly purpose: Purpose },
): Promise<DeliveryIntent> {
  const { intent, purpose } = attempt;
  const row = await connection.get(
    "SELECT p.input_digest, p.capability, p.method, p.target, p.payload, l.generation FROM operations p JOIN leases l ON l.resource_key = p.lease_key WHERE p.operation_id = ?",
    [intent.operationId],
  );
  return {
    ...intent,
    purpose,
    ...(await readCommandWaitDeadline(connection, intent)),
    inputDigest: text(row, "input_digest"),
    leaseGeneration: integer(row, "generation"),
    capability: text(row, "capability"),
    method: text(row, "method"),
    target: text(row, "target"),
    payload: text(row, "payload"),
  };
}

export interface Neighbours {
  readonly runs: Readonly<Record<string, RunState>>;
  readonly details: Readonly<Record<string, RunDetails>>;
  readonly intents: readonly EffectIntent[];
}

export async function neighbours(
  connection: SqlConnection,
  scope: { readonly runId: string; readonly effects: EffectState },
): Promise<Neighbours> {
  const others = Object.values(scope.effects.operations).filter(
    (operation) => operation.runId !== scope.runId,
  );
  const runs: Record<string, RunState> = {};
  const details: Record<string, RunDetails> = {};
  for (const runId of new Set(others.map((operation) => operation.runId))) {
    runs[runId] = storedRun(
      runRow(
        await connection.get(
          "SELECT run_id, status, revision, workflow, paused_from, gates, sequence FROM runs WHERE run_id = ?",
          [runId],
        ),
      ),
    );
    details[runId] = storedDetails(
      detailRow(
        await connection.get(
          `SELECT ${detailColumns} FROM run_details WHERE run_id = ?`,
          [runId],
        ),
      ),
    );
  }
  const intents: EffectIntent[] = [];
  for (const operation of others)
    intents.push(
      ...(
        await connection.all(
          "SELECT operation_id FROM outbox WHERE operation_id = ? AND released_sequence IS NULL",
          [operation.operationId],
        )
      ).map(() => ({
        kind: "protected-effect" as const,
        runId: operation.runId,
        operationId: operation.operationId,
      })),
    );
  return { runs, details, intents };
}
