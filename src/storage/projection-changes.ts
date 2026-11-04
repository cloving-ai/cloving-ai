import type { CommandWaitRow } from "./command-wait-rows.ts";
import type { DetailRow, GateRow } from "./decision-rows.ts";
import type { ProjectionSnapshot } from "./decision-snapshots.ts";
import type { DomainChange, StagedDelivery } from "./domain-changes.ts";
import type {
  AttemptRow,
  CommandRow,
  DefinitionRow,
  EventRow,
  OutboxRow,
  RunRow,
} from "./domain-rows.ts";
import type { OperationRow } from "./effect-rows.ts";

type Order<Row> = (left: Row, right: Row) => number;

interface Upsert<Row> {
  readonly rows: readonly Row[];
  readonly key: (row: Row) => string;
  readonly order: Order<Row>;
}

export function binaryOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function upserted<Row>(
  rows: readonly Row[],
  upsert: Upsert<Row>,
): readonly Row[] {
  if (upsert.rows.length === 0) return rows;
  const next = [...rows];
  const positions = new Map(next.map((row, index) => [upsert.key(row), index]));
  for (const row of upsert.rows) {
    const key = upsert.key(row);
    const position = positions.get(key) ?? next.length;
    positions.set(key, position);
    next[position] = row;
  }
  return next.sort(upsert.order);
}

function definitions(
  rows: readonly DefinitionRow[],
  added: readonly DefinitionRow[],
): readonly DefinitionRow[] {
  const known = new Set(rows.map((row) => row.pin));
  const fresh = added.filter((row) => {
    if (known.has(row.pin)) return false;
    known.add(row.pin);
    return true;
  });
  return upserted(rows, {
    rows: fresh,
    key: (row) => row.pin,
    order: (left, right) => binaryOrder(left.pin, right.pin),
  });
}

function runs(
  rows: readonly RunRow[],
  change: readonly RunRow[],
): readonly RunRow[] {
  return upserted(rows, {
    rows: change,
    key: (row) => row.runId,
    order: (left, right) => binaryOrder(left.runId, right.runId),
  });
}

function commands(
  rows: readonly CommandRow[],
  added: readonly CommandRow[],
): readonly CommandRow[] {
  if (added.length === 0) return rows;
  return [...rows, ...added].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

interface Guarded<Row> {
  readonly rows: Row[];
  readonly open: Map<string, number[]>;
  readonly key: (row: Row) => string;
}

function appendGuarded<Row>(
  table: Guarded<Row>,
  entry: { readonly row: Row; readonly open: boolean },
): void {
  const key = table.key(entry.row);
  if (entry.open)
    table.open.set(key, [...(table.open.get(key) ?? []), table.rows.length]);
  table.rows.push(entry.row);
}

function guarded<Row>(
  rows: readonly Row[],
  fields: {
    readonly key: (row: Row) => string;
    readonly open: (row: Row) => boolean;
  },
): Guarded<Row> {
  const table: Guarded<Row> = { rows: [], open: new Map(), key: fields.key };
  for (const row of rows) appendGuarded(table, { row, open: fields.open(row) });
  return table;
}

function settleGuarded<Row>(
  table: Guarded<Row>,
  settlement: { readonly key: string; readonly update: (row: Row) => Row },
): void {
  for (const index of table.open.get(settlement.key) ?? []) {
    const row = table.rows[index];
    if (row === undefined) continue;
    table.rows[index] = settlement.update(row);
  }
  table.open.delete(settlement.key);
}

function outbox(
  rows: readonly OutboxRow[],
  changes: readonly Pick<ProjectedChange, "added" | "released">[],
): readonly OutboxRow[] {
  if (
    changes.every(
      (change) => change.added.length + change.released.length === 0,
    )
  )
    return rows;
  const table = guarded(rows, {
    key: (row) => row.operationId,
    open: (row) => row.releasedSequence === null,
  });
  for (const change of changes) {
    for (const row of change.added)
      appendGuarded(table, {
        row: { ...row, releasedSequence: null },
        open: true,
      });
    for (const { operationId, releasedSequence } of change.released)
      settleGuarded(table, {
        key: operationId,
        update: (row) => ({ ...row, releasedSequence }),
      });
  }
  return table.rows.sort(
    (left, right) => left.createdSequence - right.createdSequence,
  );
}

function stagedAttempt(row: StagedDelivery, sequence: number): AttemptRow {
  return {
    effectId: row.effectId,
    operationId: row.operationId,
    inputDigest: row.inputDigest,
    stagedSequence: sequence,
    outcome: null,
    receipt: null,
    purpose: row.purpose,
    leaseGeneration: row.leaseGeneration,
    epoch: row.authorityEpoch,
  };
}

function deliveries(
  rows: readonly AttemptRow[],
  changes: readonly Pick<ProjectedChange, "closed" | "staged" | "sequence">[],
): readonly AttemptRow[] {
  if (
    changes.every((change) => change.closed.length + change.staged.length === 0)
  )
    return rows;
  const table = guarded(rows, {
    key: (row) => row.effectId,
    open: (row) => row.outcome === null,
  });
  for (const change of changes) {
    for (const { effectId, outcome, receipt } of change.closed)
      settleGuarded(table, {
        key: effectId,
        update: (row) => ({ ...row, outcome, receipt }),
      });
    for (const row of change.staged)
      appendGuarded(table, {
        row: stagedAttempt(row, change.sequence),
        open: true,
      });
  }
  return table.rows.sort(
    (left, right) => left.stagedSequence - right.stagedSequence,
  );
}

function gates(
  rows: readonly GateRow[],
  change: readonly GateRow[],
): readonly GateRow[] {
  return upserted(rows, {
    rows: change,
    key: (row) => JSON.stringify([row.runId, row.gateId]),
    order: (left, right) =>
      left.openedSequence - right.openedSequence ||
      binaryOrder(left.gateId, right.gateId),
  });
}

function details(
  rows: readonly DetailRow[],
  change: readonly DetailRow[],
): readonly DetailRow[] {
  return upserted(rows, {
    rows: change,
    key: (row) => row.runId,
    order: (left, right) => binaryOrder(left.runId, right.runId),
  });
}

function waits(
  rows: readonly CommandWaitRow[],
  change: readonly CommandWaitRow[],
): readonly CommandWaitRow[] {
  return upserted(rows, {
    rows: change,
    key: (row) => JSON.stringify([row.runId, row.name]),
    order: (left, right) =>
      binaryOrder(left.runId, right.runId) ||
      binaryOrder(left.name, right.name),
  });
}

function pending(
  operations: readonly string[],
  change: ProjectedChange["operations"],
): readonly string[] {
  if (change.length === 0) return operations;
  const next = new Set(operations);
  for (const row of change)
    if (row.status === "dispatch-pending") next.add(row.operationId);
    else next.delete(row.operationId);
  return [...next].sort(binaryOrder);
}

export interface ProjectedChange extends Pick<
  DomainChange,
  | "previous"
  | "sequence"
  | "definitions"
  | "runs"
  | "commands"
  | "added"
  | "released"
  | "staged"
  | "closed"
  | "gates"
  | "details"
  | "waits"
> {
  readonly events: readonly Pick<EventRow, "sequence" | "recordedAt">[];
  readonly operations: readonly Pick<OperationRow, "operationId" | "status">[];
}

export function projectedChange(change: DomainChange): ProjectedChange {
  return {
    previous: change.previous,
    sequence: change.sequence,
    definitions: change.definitions,
    events: change.events.map(({ sequence, recordedAt }) => ({
      sequence,
      recordedAt,
    })),
    runs: change.runs,
    commands: change.commands,
    added: change.added,
    released: change.released,
    staged: change.staged,
    closed: change.closed,
    gates: change.gates,
    details: change.details,
    waits: change.waits,
    operations: change.operations.map(({ operationId, status }) => ({
      operationId,
      status,
    })),
  };
}

export function followingSequence(
  sequence: number,
  change: Pick<ProjectedChange, "events">,
): number {
  return Math.max(sequence, ...change.events.map((event) => event.sequence));
}

export function changedProjection(
  snapshot: ProjectionSnapshot,
  changes: readonly ProjectedChange[],
): ProjectionSnapshot {
  const rows = <Row>(select: (change: ProjectedChange) => readonly Row[]) =>
    changes.flatMap(select);
  return {
    definitions: definitions(
      snapshot.definitions,
      rows((change) => change.definitions),
    ),
    runs: runs(
      snapshot.runs,
      rows((change) => change.runs),
    ),
    commands: commands(
      snapshot.commands,
      rows((change) => change.commands),
    ),
    outbox: outbox(snapshot.outbox, changes),
    gates: gates(
      snapshot.gates,
      rows((change) => change.gates),
    ),
    details: details(
      snapshot.details,
      rows((change) => change.details),
    ),
    waits: waits(
      snapshot.waits,
      rows((change) => change.waits),
    ),
    deliveries: deliveries(snapshot.deliveries, changes),
    pending: pending(
      snapshot.pending,
      rows((change) => change.operations),
    ),
    sequence: changes.reduce(followingSequence, snapshot.sequence),
  };
}
