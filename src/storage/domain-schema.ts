import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  integer,
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "./domain-rows.ts";

export const baselineVersion = 1;
export const adoptedVersion = 2;

export const baselineSchema = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  run_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  request TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE definitions (
  pin TEXT PRIMARY KEY,
  manifest TEXT NOT NULL
) STRICT;
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  workflow TEXT NOT NULL REFERENCES definitions (pin) DEFERRABLE INITIALLY DEFERRED,
  paused_from TEXT,
  gates TEXT NOT NULL,
  sequence INTEGER NOT NULL REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE outbox (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id) DEFERRABLE INITIALLY DEFERRED,
  created_sequence INTEGER NOT NULL REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED,
  released_sequence INTEGER REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED
) STRICT;
`;

const adoption = `
CREATE TABLE authority_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  actor_id TEXT NOT NULL,
  adoption_sequence INTEGER
) STRICT;
CREATE TABLE deliveries (
  effect_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES outbox (operation_id) DEFERRABLE INITIALLY DEFERRED,
  input_digest TEXT NOT NULL,
  staged_sequence INTEGER NOT NULL REFERENCES events (sequence) DEFERRABLE INITIALLY DEFERRED,
  outcome TEXT,
  receipt TEXT
) STRICT;
CREATE UNIQUE INDEX deliveries_open ON deliveries (operation_id) WHERE outcome IS NULL;
`;

const checksums = [baselineSchema, adoption].map((schema) =>
  createHash("sha256").update(schema).digest("hex"),
);

export type SchemaRefusal = {
  readonly kind: "refused";
  readonly reason:
    "unsupported-schema" | "foreign-database" | "schema-mismatch";
  readonly detail: string;
};

export type SchemaState =
  | { readonly kind: "new" }
  | { readonly kind: "baseline" }
  | { readonly kind: "adopted" }
  | SchemaRefusal;

export async function inspectSchema(
  connection: SqlConnection,
): Promise<SchemaState> {
  const version = integer(
    await connection.get("PRAGMA user_version"),
    "user_version",
  );
  const detail = String(version);
  if (version === 0) return emptyDatabase(connection, detail);
  if (version < 0 || version > adoptedVersion)
    return { kind: "refused", reason: "unsupported-schema", detail };
  const intact =
    (await structure(connection)) ===
      expectedStructure([baselineSchema, adoption].slice(0, version)) &&
    (await recordedChecksums(connection)) ===
      JSON.stringify(checksums.slice(0, version));
  if (!intact) return { kind: "refused", reason: "schema-mismatch", detail };
  return { kind: version === adoptedVersion ? "adopted" : "baseline" };
}

async function emptyDatabase(
  connection: SqlConnection,
  detail: string,
): Promise<SchemaState> {
  const objects = integer(
    await connection.get("SELECT count(*) AS count FROM sqlite_schema"),
    "count",
  );
  return objects === 0
    ? { kind: "new" }
    : { kind: "refused", reason: "foreign-database", detail };
}

export async function createSchema(connection: SqlConnection): Promise<void> {
  await execute(connection, baselineSchema);
  await recordVersion(connection, baselineVersion);
  await adoptSchema(connection, null);
}

export async function adoptSchema(
  connection: SqlConnection,
  pendingSequence: number | null,
): Promise<void> {
  await execute(connection, adoption);
  await recordVersion(connection, adoptedVersion);
  await connection.run(
    "INSERT INTO authority_identity (singleton, actor_id, adoption_sequence) VALUES (1, ?, ?)",
    [randomUUID(), pendingSequence],
  );
  await connection.run(`PRAGMA user_version = ${String(adoptedVersion)}`);
}

export interface AuthorityIdentity {
  readonly actorId: string;
  readonly pendingAdoption: number | null;
}

export async function backupInto(
  connection: SqlConnection,
  target: string,
): Promise<void> {
  await connection.run("VACUUM INTO ?", [target]);
}

export async function authorityIdentity(
  connection: SqlConnection,
): Promise<AuthorityIdentity> {
  const row = await connection.get(
    "SELECT actor_id, adoption_sequence FROM authority_identity WHERE singleton = 1",
  );
  return {
    actorId: text(row, "actor_id"),
    pendingAdoption: optionalInteger(row, "adoption_sequence"),
  };
}

async function execute(
  connection: SqlConnection,
  schema: string,
): Promise<void> {
  for (const statement of statements(schema)) await connection.run(statement);
}

function recordVersion(
  connection: SqlConnection,
  version: number,
): Promise<unknown> {
  return connection.run(
    "INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)",
    [version, checksums[version - 1]],
  );
}

function statements(schema: string): readonly string[] {
  return schema
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const structureQuery =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index') AND tbl_name NOT LIKE 'solid\\_%' ESCAPE '\\' ORDER BY type, name";

function structureOf(rows: readonly unknown[]): string {
  return JSON.stringify(
    rows.map((row) => [
      text(row, "type"),
      text(row, "name"),
      text(row, "tbl_name"),
      optionalText(row, "sql"),
    ]),
  );
}

async function structure(connection: SqlConnection): Promise<string> {
  return structureOf(await connection.all(structureQuery));
}

function expectedStructure(schemas: readonly string[]): string {
  const memory = new DatabaseSync(":memory:");
  for (const schema of schemas) memory.exec(schema);
  const value = structureOf(memory.prepare(structureQuery).all());
  memory.close();
  return value;
}

async function recordedChecksums(connection: SqlConnection): Promise<string> {
  return JSON.stringify(
    (
      await connection.all(
        "SELECT checksum FROM schema_migrations ORDER BY version",
      )
    ).map((row) => text(row, "checksum")),
  );
}
