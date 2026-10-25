import {
  loadDecisions,
  loadDocuments,
  type DecisionRows,
  type DocumentRow,
} from "./decision-rows.ts";
import {
  latestSequence,
  loadAttempts,
  loadSnapshot,
  outboxRow,
  projectionRows,
  text,
  type AttemptRow,
  type DomainSnapshot,
  type ProjectionRows,
  type SqlConnection,
} from "./domain-rows.ts";
import { loadEffects, type EffectRows } from "./effect-rows.ts";

export interface ProjectionSnapshot extends ProjectionRows, DecisionRows {
  readonly deliveries: readonly AttemptRow[];
  readonly pending: readonly string[];
  readonly sequence: number;
}

export interface DecidedSnapshot extends DomainSnapshot, DecisionRows {
  readonly documents: readonly DocumentRow[];
}

export interface CurrentSnapshot extends DecidedSnapshot {
  readonly effects: EffectRows;
}

export async function loadOperationSnapshot(
  connection: SqlConnection,
): Promise<Pick<ProjectionSnapshot, "outbox" | "deliveries">> {
  return {
    outbox: (
      await connection.all(
        "SELECT operation_id, kind, run_id, created_sequence, released_sequence FROM outbox ORDER BY created_sequence, rowid",
      )
    ).map(outboxRow),
    deliveries: await loadAttempts(connection),
  };
}

export async function loadProjections(
  connection: SqlConnection,
): Promise<ProjectionSnapshot> {
  return {
    ...(await projectionRows(connection)),
    ...(await loadDecisions(connection)),
    deliveries: await loadAttempts(connection),
    pending: (
      await connection.all(
        "SELECT operation_id FROM operations WHERE status = 'dispatch-pending' ORDER BY operation_id",
      )
    ).map((row) => text(row, "operation_id")),
    sequence: await latestSequence(connection),
  };
}

export async function loadDecided(
  connection: SqlConnection,
): Promise<DecidedSnapshot> {
  return {
    ...(await loadSnapshot(connection)),
    ...(await loadDecisions(connection)),
    documents: await loadDocuments(connection),
  };
}

export async function loadCurrent(
  connection: SqlConnection,
): Promise<CurrentSnapshot> {
  return {
    ...(await loadDecided(connection)),
    effects: await loadEffects(connection),
  };
}
