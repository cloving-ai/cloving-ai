import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { integer, optionalText, text } from "./authority-rows.ts";

export const schemaVersion = 1;
export const contentionMilliseconds = 250;

const schema = `
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

const schemaChecksum = createHash("sha256").update(schema).digest("hex");

const settings = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
`;

export interface ConnectionSettings {
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly lockingMode: string;
  readonly busyTimeoutMilliseconds: number;
}

export interface SchemaRefusal {
  readonly kind: "refused";
  readonly reason:
    "unsupported-schema" | "foreign-database" | "schema-mismatch";
  readonly detail: string;
}

const requiredKeys = [
  "journalMode",
  "synchronous",
  "foreignKeys",
  "lockingMode",
  "busyTimeoutMilliseconds",
] as const;

const required: Pick<ConnectionSettings, (typeof requiredKeys)[number]> = {
  journalMode: "wal",
  synchronous: 2,
  foreignKeys: 1,
  lockingMode: "exclusive",
  busyTimeoutMilliseconds: contentionMilliseconds,
};

export function requiredSettingsViolation(
  settings: ConnectionSettings,
): string | null {
  const key = requiredKeys.find((name) => settings[name] !== required[name]);
  return key === undefined ? null : `${key}=${String(settings[key])}`;
}

export function migrate(database: DatabaseSync):
  | SchemaRefusal
  | {
      readonly kind: "refused";
      readonly reason: "storage-failure";
      readonly detail: string;
    }
  | null {
  const version = integer(
    database.prepare("PRAGMA user_version").get(),
    "user_version",
  );
  const refusal = schemaRefusal(database, version);
  if (refusal !== null) return refusal;
  database.exec(settings);
  const violation = requiredSettingsViolation(observedSettings(database));
  if (violation !== null)
    return { kind: "refused", reason: "storage-failure", detail: violation };
  if (version === 0) create(database);
  return null;
}

function schemaRefusal(
  database: DatabaseSync,
  version: number,
): SchemaRefusal | null {
  const detail = String(version);
  if (version !== 0 && version !== schemaVersion)
    return { kind: "refused", reason: "unsupported-schema", detail };
  const actual = structure(database);
  if (version === 0)
    return actual === "[]"
      ? null
      : { kind: "refused", reason: "foreign-database", detail };
  const intact =
    actual === expectedStructure() &&
    recordedChecksums(database) === JSON.stringify([schemaChecksum]);
  return intact ? null : { kind: "refused", reason: "schema-mismatch", detail };
}

function structure(database: DatabaseSync): string {
  return JSON.stringify(
    database
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY type, name",
      )
      .all()
      .map((row) => [
        text(row, "type"),
        text(row, "name"),
        text(row, "tbl_name"),
        optionalText(row, "sql"),
      ]),
  );
}

function expectedStructure(): string {
  const memory = new DatabaseSync(":memory:");
  memory.exec(schema);
  const value = structure(memory);
  memory.close();
  return value;
}

function recordedChecksums(database: DatabaseSync): string {
  return JSON.stringify(
    database
      .prepare("SELECT checksum FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => text(row, "checksum")),
  );
}

function create(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  database.exec(schema);
  database
    .prepare("INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)")
    .run(schemaVersion, schemaChecksum);
  database.exec(`PRAGMA user_version = ${String(schemaVersion)}`);
  database.exec("COMMIT");
}

export function observedSettings(database: DatabaseSync): ConnectionSettings {
  const pragma = (name: string): unknown =>
    database.prepare(`PRAGMA ${name}`).get();
  return {
    schemaVersion: integer(pragma("user_version"), "user_version"),
    journalMode: text(pragma("journal_mode"), "journal_mode"),
    synchronous: integer(pragma("synchronous"), "synchronous"),
    foreignKeys: integer(pragma("foreign_keys"), "foreign_keys"),
    lockingMode: text(pragma("locking_mode"), "locking_mode"),
    busyTimeoutMilliseconds: integer(pragma("busy_timeout"), "timeout"),
  };
}
