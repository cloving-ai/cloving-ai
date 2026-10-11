import {
  loadDecisions,
  loadDocuments,
  type DecisionRows,
  type DocumentRow,
} from "./decision-rows.ts";
import {
  latestSequence,
  loadDeliveries,
  loadSnapshot,
  projectionRows,
  type DeliveryRow,
  type DomainSnapshot,
  type ProjectionRows,
  type SqlConnection,
} from "./domain-rows.ts";

export interface ProjectionSnapshot extends ProjectionRows, DecisionRows {
  readonly deliveries: readonly DeliveryRow[];
  readonly sequence: number;
}

export interface CurrentSnapshot extends DomainSnapshot, DecisionRows {
  readonly documents: readonly DocumentRow[];
}

export async function loadProjections(
  connection: SqlConnection,
): Promise<ProjectionSnapshot> {
  return {
    ...(await projectionRows(connection)),
    ...(await loadDecisions(connection)),
    deliveries: await loadDeliveries(connection),
    sequence: await latestSequence(connection),
  };
}

export async function loadCurrent(
  connection: SqlConnection,
): Promise<CurrentSnapshot> {
  return {
    ...(await loadSnapshot(connection)),
    ...(await loadDecisions(connection)),
    documents: await loadDocuments(connection),
  };
}
