import type { Database } from "solid-objects";
import { integer, text } from "../../storage/domain-rows.ts";
import { inspectFile } from "../../storage/domain-schema.ts";

export const contentionMilliseconds = 250;

export interface Refusal {
  readonly kind: "refused";
  readonly reason: string;
  readonly detail: string;
}

export interface ConnectionSettings {
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly lockingMode: string;
  readonly busyTimeoutMilliseconds: number;
}

const required = {
  journalMode: "wal",
  synchronous: 2,
  foreignKeys: 1,
  lockingMode: "exclusive",
  busyTimeoutMilliseconds: contentionMilliseconds,
} as const;

export async function lockExclusively(database: Database): Promise<void> {
  await database.connection(async (connection) => {
    await connection.run("PRAGMA locking_mode = EXCLUSIVE");
  });
}

export async function takeOwnership(database: Database): Promise<void> {
  await database.connection(async (connection) => {
    await connection.run("PRAGMA journal_mode = WAL");
    await connection.run("PRAGMA synchronous = FULL");
    await connection.run("PRAGMA foreign_keys = ON");
  });
  await database.transaction(() => Promise.resolve());
}

export function observeSettings(
  database: Database,
): Promise<ConnectionSettings> {
  return database.connection(async (connection) => {
    const pragma = async (name: string): Promise<unknown> =>
      connection.get(`PRAGMA ${name}`);
    return {
      schemaVersion: integer(await pragma("user_version"), "user_version"),
      journalMode: text(await pragma("journal_mode"), "journal_mode"),
      synchronous: integer(await pragma("synchronous"), "synchronous"),
      foreignKeys: integer(await pragma("foreign_keys"), "foreign_keys"),
      lockingMode: text(await pragma("locking_mode"), "locking_mode"),
      busyTimeoutMilliseconds: integer(await pragma("busy_timeout"), "timeout"),
    };
  });
}

export function requiredSettingsViolation(
  settings: ConnectionSettings,
): string | null {
  const key = Object.keys(required).find(
    (name) => Reflect.get(settings, name) !== Reflect.get(required, name),
  );
  return key === undefined
    ? null
    : `${key}=${String(Reflect.get(settings, key))}`;
}

export function storageRefusal(error: unknown): Refusal {
  if (!(error instanceof Error))
    return {
      kind: "refused",
      reason: "storage-failure",
      detail: "storage threw a value that is not an Error",
    };
  return {
    kind: "refused",
    reason: lockContention(error) ? "authority-held" : "storage-failure",
    detail: error.message,
  };
}

export async function fileRefusal(path: string): Promise<Refusal | undefined> {
  try {
    const schema = await inspectFile({
      path,
      timeoutMilliseconds: contentionMilliseconds,
    });
    return schema.kind === "refused" ? schema : undefined;
  } catch (error) {
    return storageRefusal(error);
  }
}

export function lockContention(error: Error): boolean {
  return (
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === 5
  );
}
