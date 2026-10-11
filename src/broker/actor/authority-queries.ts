import type { Database } from "solid-objects";
import { parseCommand } from "../../authority/commands.ts";
import type {
  AuthorityCommand,
  AuthorityEvent,
} from "../../authority/transitions.ts";
import { documentBody } from "../../storage/decision-rows.ts";
import {
  integer,
  latestSequence,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { storedEvents } from "../authority-restore.ts";
import { documentDigest } from "../decision-restore.ts";

export interface CommandRecord {
  readonly commandId: string;
  readonly sequence: number;
  readonly runId: string;
  readonly recordedAt: string;
  readonly commandDigest: string;
  readonly command: AuthorityCommand;
}

export type PublishedEvent = Omit<AuthorityEvent, "request">;

export interface EventPage {
  readonly events: readonly PublishedEvent[];
  readonly earliest: number;
  readonly latest: number;
}

export interface EventCursor {
  readonly after: number;
  readonly limit: number;
  readonly runId?: string;
}

export interface Sequences {
  readonly latest: number;
  readonly runs: Readonly<Record<string, number>>;
  readonly times: Readonly<Record<string, string>>;
}

export interface AuthorityQueries {
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly receipt: (commandId: string) => Promise<CommandRecord | undefined>;
  readonly eventsAfter: (cursor: EventCursor) => Promise<EventPage>;
  readonly sequences: () => Promise<Sequences>;
}

async function receipt(
  connection: SqlConnection,
  commandId: string,
): Promise<CommandRecord | undefined> {
  const row = await connection.get(
    "SELECT c.request, c.sequence, e.run_id, e.recorded_at FROM commands c JOIN events e ON e.sequence = c.sequence WHERE c.command_id = ?",
    [commandId],
  );
  if (row === undefined) return undefined;
  const request = text(row, "request");
  const command = parseCommand(JSON.parse(request));
  if (command === null) throw new Error(`invalid-command-row: ${commandId}`);
  return {
    commandId,
    sequence: integer(row, "sequence"),
    runId: text(row, "run_id"),
    recordedAt: text(row, "recorded_at"),
    commandDigest: documentDigest(request),
    command,
  };
}

async function eventsAfter(
  connection: SqlConnection,
  cursor: EventCursor,
): Promise<EventPage> {
  const scoped = cursor.runId === undefined ? "" : " AND run_id = ?";
  const parameters =
    cursor.runId === undefined
      ? [cursor.after, cursor.limit]
      : [cursor.after, cursor.runId, cursor.limit];
  const rows = await connection.all(
    `SELECT sequence, type, run_id, command_id, recorded_at, payload FROM events WHERE sequence > ?${scoped} ORDER BY sequence LIMIT ?`,
    parameters,
  );
  return {
    events: storedEvents(
      rows.map((row) => ({
        sequence: integer(row, "sequence"),
        type: text(row, "type"),
        runId: text(row, "run_id"),
        commandId: text(row, "command_id"),
        recordedAt: text(row, "recorded_at"),
        request: "",
        payload: text(row, "payload"),
      })),
    ).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      runId: event.runId,
      commandId: event.commandId,
      recordedAt: event.recordedAt,
      payload: event.payload,
    })),
    earliest: integer(
      await connection.get(
        "SELECT coalesce(min(sequence), 0) AS sequence FROM events",
      ),
      "sequence",
    ),
    latest: await latestSequence(connection),
  };
}

async function sequences(connection: SqlConnection): Promise<Sequences> {
  const rows = await connection.all(
    "SELECT r.run_id, r.sequence, e.recorded_at FROM runs r JOIN events e ON e.sequence = r.sequence ORDER BY r.run_id",
  );
  return {
    latest: await latestSequence(connection),
    runs: Object.fromEntries(
      rows.map((row) => [text(row, "run_id"), integer(row, "sequence")]),
    ),
    times: Object.fromEntries(
      rows.map((row) => [text(row, "run_id"), text(row, "recorded_at")]),
    ),
  };
}

export function authorityQueries(access: {
  readonly reader: Database;
  readonly ready: () => Promise<void>;
}): AuthorityQueries {
  const { reader, ready } = access;
  async function read<Value>(
    query: (connection: SqlConnection) => Promise<Value>,
  ): Promise<Value> {
    await ready();
    return reader.connection(query);
  }
  return {
    document: (digest) =>
      read((connection) => documentBody(connection, digest)),
    receipt: (commandId) =>
      read((connection) => receipt(connection, commandId)),
    eventsAfter: (cursor) =>
      read((connection) => eventsAfter(connection, cursor)),
    sequences: () => read(sequences),
  };
}
