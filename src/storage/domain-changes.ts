import {
  detailColumns,
  detailRow,
  documentRow,
  gateColumns,
  gateRow,
  type DetailRow,
  type DocumentRow,
  type GateRow,
} from "./decision-rows.ts";
import {
  commandRow,
  definitionRow,
  eventRow,
  integer,
  latestSequence,
  optionalText,
  runRow,
  text,
  type CommandRow,
  type DefinitionRow,
  type EventRow,
  type RunRow,
  type SqlConnection,
} from "./domain-rows.ts";

export interface StagedDelivery {
  readonly effectId: string;
  readonly operationId: string;
  readonly inputDigest: string;
}

export interface ClosedDelivery {
  readonly effectId: string;
  readonly outcome: string;
  readonly receipt: string | null;
}

export interface AddedIntent {
  readonly operationId: string;
  readonly kind: string;
  readonly runId: string;
}

export interface DomainChange {
  readonly previous: number;
  readonly sequence: number;
  readonly definitions: readonly DefinitionRow[];
  readonly events: readonly EventRow[];
  readonly runs: readonly RunRow[];
  readonly commands: readonly CommandRow[];
  readonly added: readonly AddedIntent[];
  readonly released: readonly string[];
  readonly staged: readonly StagedDelivery[];
  readonly closed: readonly ClosedDelivery[];
  readonly gates: readonly GateRow[];
  readonly details: readonly DetailRow[];
  readonly documents: readonly DocumentRow[];
  readonly completesAdoption: boolean;
}

export async function persistChange(
  value: unknown,
  connection: SqlConnection,
): Promise<void> {
  const change = parseChange(value);
  if ((await latestSequence(connection)) !== change.previous)
    throw new Error("stale-authority-sequence");
  for (const statement of statements(change))
    await connection.run(statement.sql, statement.parameters);
}

export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function statements(change: DomainChange): readonly Statement[] {
  return [
    ...change.definitions.map((row) => ({
      sql: "INSERT INTO definitions (pin, manifest) VALUES (?, ?) ON CONFLICT (pin) DO NOTHING",
      parameters: [row.pin, row.manifest],
    })),
    ...change.events.map((row) => ({
      sql: "INSERT INTO events (sequence, type, run_id, command_id, recorded_at, request, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      parameters: [
        row.sequence,
        row.type,
        row.runId,
        row.commandId,
        row.recordedAt,
        row.request,
        row.payload,
      ],
    })),
    ...change.runs.map((row) => ({
      sql: "INSERT INTO runs (run_id, status, revision, workflow, paused_from, gates, sequence) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, revision = excluded.revision, workflow = excluded.workflow, paused_from = excluded.paused_from, gates = excluded.gates, sequence = excluded.sequence",
      parameters: [
        row.runId,
        row.status,
        row.revision,
        row.workflow,
        row.pausedFrom,
        row.gates,
        row.sequence,
      ],
    })),
    ...change.commands.map((row) => ({
      sql: "INSERT INTO commands (command_id, request, sequence) VALUES (?, ?, ?)",
      parameters: [row.commandId, row.request, row.sequence],
    })),
    ...intentStatements(change),
    ...deliveryStatements(change),
    ...decisionStatements(change),
    ...(change.completesAdoption
      ? [
          {
            sql: "UPDATE authority_identity SET adoption_sequence = NULL WHERE singleton = 1 AND adoption_sequence = ?",
            parameters: [change.sequence],
          },
        ]
      : []),
  ];
}

function intentStatements(change: DomainChange): readonly Statement[] {
  return [
    ...change.added.map((row) => ({
      sql: "INSERT INTO outbox (operation_id, kind, run_id, created_sequence) VALUES (?, ?, ?, ?)",
      parameters: [row.operationId, row.kind, row.runId, change.sequence],
    })),
    ...change.released.map((operationId) => ({
      sql: "UPDATE outbox SET released_sequence = ? WHERE operation_id = ? AND released_sequence IS NULL",
      parameters: [change.sequence, operationId],
    })),
  ];
}

function deliveryStatements(change: DomainChange): readonly Statement[] {
  return [
    ...change.closed.map((row) => ({
      sql: "UPDATE deliveries SET outcome = ?, receipt = ? WHERE effect_id = ? AND outcome IS NULL",
      parameters: [row.outcome, row.receipt, row.effectId],
    })),
    ...change.staged.map((row) => ({
      sql: "INSERT INTO deliveries (effect_id, operation_id, input_digest, staged_sequence) VALUES (?, ?, ?, ?)",
      parameters: [
        row.effectId,
        row.operationId,
        row.inputDigest,
        change.sequence,
      ],
    })),
  ];
}

const gateNames = gateColumns.split(", ");
const detailNames = detailColumns.split(", ");

function upsert(target: {
  readonly table: string;
  readonly names: readonly string[];
  readonly key: number;
}): string {
  const { table, names, key } = target;
  const updates = names
    .slice(key)
    .map((name) => `${name} = excluded.${name}`)
    .join(", ");
  return `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT (${names.slice(0, key).join(", ")}) DO UPDATE SET ${updates}`;
}

const gateUpsert = upsert({ table: "gates", names: gateNames, key: 2 });
const detailUpsert = upsert({
  table: "run_details",
  names: detailNames,
  key: 1,
});

export function gateParameters(row: GateRow): readonly unknown[] {
  return [
    row.runId,
    row.gateId,
    row.kind,
    row.label,
    row.subject,
    row.prompt,
    row.expiresAt,
    row.generation,
    row.revision,
    row.wait,
    row.decision,
    row.answer,
    row.decidedSequence,
    row.openedSequence,
    row.continuation,
  ];
}

export function detailParameters(row: DetailRow): readonly unknown[] {
  return [
    row.runId,
    row.generation,
    row.submission,
    row.input,
    row.resolver,
    row.condition,
    row.reason,
    row.evidence,
    row.retryAt,
    row.attempt,
    row.attemptLimit,
    row.observedSequence,
    row.observedAt,
    row.observedOperation,
  ];
}

export function decisionStatements(
  change: Pick<DomainChange, "gates" | "details" | "documents">,
): readonly Statement[] {
  return [
    ...change.gates.map((row) => ({
      sql: gateUpsert,
      parameters: gateParameters(row),
    })),
    ...change.details.map((row) => ({
      sql: detailUpsert,
      parameters: detailParameters(row),
    })),
    ...change.documents.map((row) => ({
      sql: "INSERT INTO documents (digest, body) VALUES (?, ?) ON CONFLICT (digest) DO NOTHING",
      parameters: [row.digest, row.body],
    })),
  ];
}

export async function persistDecisions(
  connection: SqlConnection,
  rows: Pick<DomainChange, "gates" | "details" | "documents">,
): Promise<void> {
  for (const statement of decisionStatements(rows))
    await connection.run(statement.sql, statement.parameters);
}

function parseChange(value: unknown): DomainChange {
  return {
    previous: integer(value, "previous"),
    sequence: integer(value, "sequence"),
    definitions: list(value, "definitions").map(definitionRow),
    events: list(value, "events").map(eventRow),
    runs: list(value, "runs").map(runRow),
    commands: list(value, "commands").map(commandRow),
    added: list(value, "added").map((row) => ({
      operationId: text(row, "operation_id"),
      kind: text(row, "kind"),
      runId: text(row, "run_id"),
    })),
    released: list(value, "released").map((row) => text(row, "operation_id")),
    staged: list(value, "staged").map((row) => ({
      effectId: text(row, "effect_id"),
      operationId: text(row, "operation_id"),
      inputDigest: text(row, "input_digest"),
    })),
    closed: list(value, "closed").map((row) => ({
      effectId: text(row, "effect_id"),
      outcome: text(row, "outcome"),
      receipt: optionalText(row, "receipt"),
    })),
    gates: list(value, "gates").map(gateRow),
    details: list(value, "details").map(detailRow),
    documents: list(value, "documents").map(documentRow),
    completesAdoption:
      Reflect.get(Object(value), "completes_adoption") === true,
  };
}

function list(value: unknown, name: string): readonly unknown[] {
  const items: unknown = Reflect.get(Object(value), name);
  if (!Array.isArray(items)) throw new Error(`invalid-column: ${name}`);
  return items;
}
