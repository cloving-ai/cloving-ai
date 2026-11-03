import type { CommandWaitRow } from "./command-wait-rows.ts";
import type { DetailRow, GateRow } from "./decision-rows.ts";
import type { ProjectionSnapshot } from "./decision-snapshots.ts";
import type { DomainChange } from "./domain-changes.ts";
import type {
  AttemptRow,
  CommandRow,
  DefinitionRow,
  OutboxRow,
  RunRow,
} from "./domain-rows.ts";

type Order<Row> = (left: Row, right: Row) => number;

interface Upsert<Row> {
  readonly rows: readonly Row[];
  readonly key: (row: Row) => string;
  readonly order: Order<Row>;
}

export function binaryOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function firstByKey<Value>(
  entries: readonly (readonly [string, Value])[],
): ReadonlyMap<string, Value> {
  return new Map(entries.toReversed());
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

function outbox(
  rows: readonly OutboxRow[],
  change: Pick<DomainChange, "added" | "released">,
): readonly OutboxRow[] {
  if (change.added.length === 0 && change.released.length === 0) return rows;
  const added = change.added.map((row) => ({
    ...row,
    releasedSequence: null,
  }));
  const released = firstByKey(
    change.released.map((row) => [row.operationId, row.releasedSequence]),
  );
  const next = [...rows, ...added].map((row) => {
    const sequence = released.get(row.operationId);
    return sequence === undefined || row.releasedSequence !== null
      ? row
      : { ...row, releasedSequence: sequence };
  });
  return next.sort(
    (left, right) => left.createdSequence - right.createdSequence,
  );
}

function deliveries(
  rows: readonly AttemptRow[],
  change: Pick<DomainChange, "closed" | "staged" | "sequence">,
): readonly AttemptRow[] {
  if (change.closed.length === 0 && change.staged.length === 0) return rows;
  const closed = firstByKey(change.closed.map((row) => [row.effectId, row]));
  const settled = rows.map((row) => {
    const outcome = closed.get(row.effectId);
    return outcome === undefined || row.outcome !== null
      ? row
      : { ...row, outcome: outcome.outcome, receipt: outcome.receipt };
  });
  const staged = change.staged.map((row) => ({
    effectId: row.effectId,
    operationId: row.operationId,
    inputDigest: row.inputDigest,
    stagedSequence: change.sequence,
    outcome: null,
    receipt: null,
    purpose: row.purpose,
    leaseGeneration: row.leaseGeneration,
    epoch: row.authorityEpoch,
  }));
  return [...settled, ...staged].sort(
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
  change: DomainChange["operations"],
): readonly string[] {
  if (change.length === 0) return operations;
  const next = new Set(operations);
  for (const row of change)
    if (row.status === "dispatch-pending") next.add(row.operationId);
    else next.delete(row.operationId);
  return [...next].sort(binaryOrder);
}

export function changedProjection(
  snapshot: ProjectionSnapshot,
  change: DomainChange,
): ProjectionSnapshot {
  return {
    definitions: definitions(snapshot.definitions, change.definitions),
    runs: runs(snapshot.runs, change.runs),
    commands: commands(snapshot.commands, change.commands),
    outbox: outbox(snapshot.outbox, change),
    gates: gates(snapshot.gates, change.gates),
    details: details(snapshot.details, change.details),
    waits: waits(snapshot.waits, change.waits),
    deliveries: deliveries(snapshot.deliveries, change),
    pending: pending(snapshot.pending, change.operations),
    sequence: Math.max(
      snapshot.sequence,
      ...change.events.map((event) => event.sequence),
    ),
  };
}
