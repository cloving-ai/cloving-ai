export interface SqlConnection {
  readonly run: (
    sql: string,
    parameters?: readonly unknown[],
  ) => Promise<unknown>;
  readonly get: (
    sql: string,
    parameters?: readonly unknown[],
  ) => Promise<unknown>;
  readonly all: (
    sql: string,
    parameters?: readonly unknown[],
  ) => Promise<readonly unknown[]>;
}

export interface EventRow {
  readonly sequence: number;
  readonly type: string;
  readonly runId: string;
  readonly commandId: string;
  readonly recordedAt: string;
  readonly request: string;
  readonly payload: string;
}

export interface RunRow {
  readonly runId: string;
  readonly status: string;
  readonly revision: number;
  readonly workflow: string;
  readonly pausedFrom: string | null;
  readonly gates: string;
  readonly sequence: number;
}

export interface CommandRow {
  readonly commandId: string;
  readonly request: string;
  readonly sequence: number;
}

export interface IntentRow {
  readonly operationId: string;
  readonly kind: string;
  readonly runId: string;
  readonly createdSequence: number;
}

export interface OutboxRow extends IntentRow {
  readonly releasedSequence: number | null;
}

export interface DefinitionRow {
  readonly pin: string;
  readonly manifest: string;
}

export interface DeliveryRow {
  readonly effectId: string;
  readonly operationId: string;
  readonly inputDigest: string;
  readonly stagedSequence: number;
  readonly outcome: string | null;
  readonly receipt: string | null;
}

export interface AuthoritySnapshot {
  readonly definitions: readonly DefinitionRow[];
  readonly events: readonly EventRow[];
  readonly runs: readonly RunRow[];
  readonly commands: readonly CommandRow[];
  readonly outbox: readonly OutboxRow[];
}

export interface DomainSnapshot extends AuthoritySnapshot {
  readonly deliveries: readonly DeliveryRow[];
}

export type ProjectionRows = Omit<AuthoritySnapshot, "events">;

export interface ProjectionSnapshot extends ProjectionRows {
  readonly deliveries: readonly DeliveryRow[];
  readonly sequence: number;
}

export async function loadSnapshot(
  connection: SqlConnection,
): Promise<DomainSnapshot> {
  return {
    ...(await loadBaseline(connection)),
    deliveries: await loadDeliveries(connection),
  };
}

export async function loadBaseline(
  connection: SqlConnection,
): Promise<AuthoritySnapshot> {
  return {
    ...(await projectionRows(connection)),
    events: await loadEvents(connection),
  };
}

export async function loadProjections(
  connection: SqlConnection,
): Promise<ProjectionSnapshot> {
  return {
    ...(await projectionRows(connection)),
    deliveries: await loadDeliveries(connection),
    sequence: await latestSequence(connection),
  };
}

export async function loadEvents(
  connection: SqlConnection,
): Promise<readonly EventRow[]> {
  return (
    await connection.all(
      "SELECT sequence, type, run_id, command_id, recorded_at, request, payload FROM events ORDER BY sequence",
    )
  ).map(eventRow);
}

async function loadDeliveries(
  connection: SqlConnection,
): Promise<readonly DeliveryRow[]> {
  return (
    await connection.all(
      "SELECT effect_id, operation_id, input_digest, staged_sequence, outcome, receipt FROM deliveries ORDER BY staged_sequence, rowid",
    )
  ).map(deliveryRow);
}

async function projectionRows(
  connection: SqlConnection,
): Promise<ProjectionRows> {
  const rows = (sql: string): Promise<readonly unknown[]> =>
    connection.all(sql);
  return {
    definitions: (
      await rows("SELECT pin, manifest FROM definitions ORDER BY pin")
    ).map(definitionRow),
    runs: (
      await rows(
        "SELECT run_id, status, revision, workflow, paused_from, gates, sequence FROM runs ORDER BY run_id",
      )
    ).map(runRow),
    commands: (
      await rows(
        "SELECT command_id, request, sequence FROM commands ORDER BY sequence",
      )
    ).map(commandRow),
    outbox: (
      await rows(
        "SELECT operation_id, kind, run_id, created_sequence, released_sequence FROM outbox ORDER BY created_sequence, rowid",
      )
    ).map(outboxRow),
  };
}

export async function latestSequence(
  connection: SqlConnection,
): Promise<number> {
  return integer(
    await connection.get(
      "SELECT coalesce(max(sequence), 0) AS sequence FROM events",
    ),
    "sequence",
  );
}

export function definitionRow(row: unknown): DefinitionRow {
  return { pin: text(row, "pin"), manifest: text(row, "manifest") };
}

export function eventRow(row: unknown): EventRow {
  return {
    sequence: integer(row, "sequence"),
    type: text(row, "type"),
    runId: text(row, "run_id"),
    commandId: text(row, "command_id"),
    recordedAt: text(row, "recorded_at"),
    request: text(row, "request"),
    payload: text(row, "payload"),
  };
}

export function runRow(row: unknown): RunRow {
  return {
    runId: text(row, "run_id"),
    status: text(row, "status"),
    revision: integer(row, "revision"),
    workflow: text(row, "workflow"),
    pausedFrom: optionalText(row, "paused_from"),
    gates: text(row, "gates"),
    sequence: integer(row, "sequence"),
  };
}

export function commandRow(row: unknown): CommandRow {
  return {
    commandId: text(row, "command_id"),
    request: text(row, "request"),
    sequence: integer(row, "sequence"),
  };
}

export function outboxRow(row: unknown): OutboxRow {
  return {
    operationId: text(row, "operation_id"),
    kind: text(row, "kind"),
    runId: text(row, "run_id"),
    createdSequence: integer(row, "created_sequence"),
    releasedSequence: optionalInteger(row, "released_sequence"),
  };
}

export function deliveryRow(row: unknown): DeliveryRow {
  return {
    effectId: text(row, "effect_id"),
    operationId: text(row, "operation_id"),
    inputDigest: text(row, "input_digest"),
    stagedSequence: integer(row, "staged_sequence"),
    outcome: optionalText(row, "outcome"),
    receipt: optionalText(row, "receipt"),
  };
}

function column<Value>(
  row: unknown,
  field: {
    readonly name: string;
    readonly accepts: (value: unknown) => value is Value;
  },
): Value {
  const { name, accepts } = field;
  const value: unknown = Reflect.get(Object(row), name);
  if (!accepts(value)) throw new Error(`invalid-column: ${name}`);
  return value;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeInteger(value: unknown): value is number | bigint {
  if (typeof value === "bigint")
    return (
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    );
  return Number.isSafeInteger(value);
}

function isOptionalSafeInteger(
  value: unknown,
): value is number | bigint | null {
  return value === null || isSafeInteger(value);
}

export function text(row: unknown, name: string): string {
  return column(row, { name, accepts: isText });
}

export function optionalText(row: unknown, name: string): string | null {
  return column(row, { name, accepts: isOptionalText });
}

export function integer(row: unknown, name: string): number {
  return Number(column(row, { name, accepts: isSafeInteger }));
}

export function optionalInteger(row: unknown, name: string): number | null {
  const value = column(row, { name, accepts: isOptionalSafeInteger });
  return value === null ? null : Number(value);
}
