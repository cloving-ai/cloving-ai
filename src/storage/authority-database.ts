import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  load,
  type AuthoritySnapshot,
  type CommandRow,
  type DefinitionRow,
  type EventRow,
  type IntentRow,
  type RunRow,
} from "./authority-rows.ts";
import {
  contentionMilliseconds,
  migrate,
  observedSettings,
  type ConnectionSettings,
  type SchemaRefusal,
} from "./authority-schema.ts";

export {
  contentionMilliseconds,
  requiredSettingsViolation,
  schemaVersion,
  type ConnectionSettings,
} from "./authority-schema.ts";

export type {
  AuthoritySnapshot,
  CommandRow,
  DefinitionRow,
  EventRow,
  IntentRow,
  OutboxRow,
  RunRow,
} from "./authority-rows.ts";

export interface AuthorityChange {
  readonly sequence: number;
  readonly definitions: readonly DefinitionRow[];
  readonly events: readonly EventRow[];
  readonly runs: readonly RunRow[];
  readonly commands: readonly CommandRow[];
  readonly added: readonly IntentRow[];
  readonly released: readonly string[];
}

export type CommitOutcome =
  | { readonly kind: "committed" }
  | {
      readonly kind: "failed";
      readonly reason: "storage-failure" | "storage-unavailable";
      readonly detail: string;
    };

export interface AuthorityDatabase {
  readonly commit: (change: AuthorityChange) => CommitOutcome;
  readonly load: () => AuthoritySnapshot;
  readonly settings: () => ConnectionSettings;
  readonly close: () => void;
}

export type DatabaseOpening =
  | { readonly kind: "opened"; readonly database: AuthorityDatabase }
  | {
      readonly kind: "refused";
      readonly reason: "authority-held" | "storage-failure";
      readonly detail: string;
    }
  | SchemaRefusal;

export function openAuthorityDatabase(file: string): DatabaseOpening {
  const database = new DatabaseSync(file, { timeout: contentionMilliseconds });
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    const refusal = migrate(database);
    if (refusal === null)
      return { kind: "opened", database: connection(database) };
    database.close();
    return refusal;
  } catch (error) {
    database.close();
    return {
      kind: "refused",
      reason: lockContention(error) ? "authority-held" : "storage-failure",
      detail: message(error),
    };
  }
}

export function lockContention(error: unknown): boolean {
  return (Number(Reflect.get(Object(error), "errcode")) & 0xff) === 5;
}

function message(error: unknown): string {
  return String(Reflect.get(Object(error), "message"));
}

type Statements = Readonly<
  Record<
    "definition" | "event" | "run" | "command" | "intent" | "release",
    StatementSync
  >
>;

function connection(database: DatabaseSync): AuthorityDatabase {
  const statements: Statements = {
    definition: database.prepare(
      "INSERT INTO definitions (pin, manifest) VALUES (?, ?) ON CONFLICT (pin) DO NOTHING",
    ),
    event: database.prepare(
      "INSERT INTO events (sequence, type, run_id, command_id, recorded_at, request, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    run: database.prepare(
      "INSERT INTO runs (run_id, status, revision, workflow, paused_from, gates, sequence) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, revision = excluded.revision, workflow = excluded.workflow, paused_from = excluded.paused_from, gates = excluded.gates, sequence = excluded.sequence",
    ),
    command: database.prepare(
      "INSERT INTO commands (command_id, request, sequence) VALUES (?, ?, ?)",
    ),
    intent: database.prepare(
      "INSERT INTO outbox (operation_id, kind, run_id, created_sequence) VALUES (?, ?, ?, ?)",
    ),
    release: database.prepare(
      "UPDATE outbox SET released_sequence = ? WHERE operation_id = ? AND released_sequence IS NULL",
    ),
  };
  let open = true;
  const close = (): void => {
    if (open) database.close();
    open = false;
  };
  return {
    commit: (change) => {
      if (!open) return unavailable;
      const outcome = commit(database, statements, change);
      if (outcome.kind === "failed") close();
      return outcome;
    },
    load: () => load(database),
    settings: () => observedSettings(database),
    close,
  };
}

const unavailable: CommitOutcome = {
  kind: "failed",
  reason: "storage-unavailable",
  detail: "closed after storage failure",
};

function commit(
  database: DatabaseSync,
  statements: Statements,
  change: AuthorityChange,
): CommitOutcome {
  try {
    database.exec("BEGIN IMMEDIATE");
    write(statements, change);
    database.exec("COMMIT");
    return { kind: "committed" };
  } catch (error) {
    return {
      kind: "failed",
      reason: "storage-failure",
      detail: message(error),
    };
  }
}

function write(statements: Statements, change: AuthorityChange): void {
  for (const definition of change.definitions)
    statements.definition.run(definition.pin, definition.manifest);
  for (const event of change.events)
    statements.event.run(
      event.sequence,
      event.type,
      event.runId,
      event.commandId,
      event.recordedAt,
      event.request,
      event.payload,
    );
  for (const run of change.runs)
    statements.run.run(
      run.runId,
      run.status,
      run.revision,
      run.workflow,
      run.pausedFrom,
      run.gates,
      run.sequence,
    );
  for (const command of change.commands)
    statements.command.run(
      command.commandId,
      command.request,
      command.sequence,
    );
  for (const intent of change.added)
    statements.intent.run(
      intent.operationId,
      intent.kind,
      intent.runId,
      intent.createdSequence,
    );
  for (const operationId of change.released)
    statements.release.run(change.sequence, operationId);
}
