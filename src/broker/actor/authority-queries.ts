import type { Database } from "solid-objects";
import { readExecutionManifest } from "../../execution-pin.ts";
import type { ExecutionManifest } from "../../workflow-admission.ts";
import { parseCommand } from "../../authority/commands.ts";
import type {
  AuthorityCommand,
  AuthorityEvent,
  RunState,
} from "../../authority/transitions.ts";
import { documentBody } from "../../storage/decision-rows.ts";
import {
  integer,
  optionalText,
  latestSequence,
  runRow,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { storedEvents, storedRun } from "../authority-restore.ts";
import { documentDigest } from "../decision-restore.ts";
import {
  runLinks,
  type RunLinks,
  type RunOrigins,
} from "../../authority/handoff-chain.ts";

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

export interface CompletionCursor {
  readonly runId: string;
  readonly atOrBefore: number;
  readonly terminal?: boolean;
}

export interface RunRecord extends RunState {
  readonly sequence: number;
}

export interface AuthorityQueries {
  readonly run: (runId: string) => Promise<RunRecord | undefined>;
  readonly manifest: (runId: string) => Promise<ExecutionManifest | undefined>;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly receipt: (commandId: string) => Promise<CommandRecord | undefined>;
  readonly eventsAfter: (cursor: EventCursor) => Promise<EventPage>;
  readonly latestCompletion: (
    cursor: CompletionCursor,
  ) => Promise<PublishedEvent | undefined>;
  readonly sequences: () => Promise<Sequences>;
  readonly workflowIds: (
    runIds?: readonly string[],
  ) => Promise<Readonly<Record<string, string>>>;
  readonly runOrigins: () => Promise<RunOrigins>;
  readonly runLinks: () => Promise<Readonly<Record<string, RunLinks>>>;
}

async function run(
  connection: SqlConnection,
  runId: string,
): Promise<RunRecord | undefined> {
  const row = await connection.get(
    "SELECT run_id, status, revision, workflow, paused_from, gates, sequence FROM runs WHERE run_id = ?",
    [runId],
  );
  if (row === undefined) return undefined;
  const record = runRow(row);
  return { ...storedRun(record), sequence: record.sequence };
}

async function runOrigins(
  connection: SqlConnection,
  cursor: { readonly after: number; readonly through: number },
): Promise<RunOrigins> {
  const rows = await connection.all(
    "SELECT run_id, json_extract(payload, '$.parentRunId') AS parent_run_id, coalesce(json_extract(payload, '$.chainId'), run_id) AS chain_id FROM events WHERE type = 'run.created' AND sequence > ? AND sequence <= ? ORDER BY sequence",
    [cursor.after, cursor.through],
  );
  return Object.fromEntries(
    rows.map((row) => [
      text(row, "run_id"),
      {
        parentRunId: optionalText(row, "parent_run_id"),
        chainId: text(row, "chain_id"),
      },
    ]),
  );
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
    events: publishedEvents(rows),
    earliest: integer(
      await connection.get(
        "SELECT coalesce(min(sequence), 0) AS sequence FROM events",
      ),
      "sequence",
    ),
    latest: await latestSequence(connection),
  };
}

function publishedEvents(rows: readonly unknown[]): readonly PublishedEvent[] {
  return storedEvents(
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
  }));
}

async function latestCompletion(
  connection: SqlConnection,
  cursor: CompletionCursor,
): Promise<PublishedEvent | undefined> {
  const types =
    cursor.terminal === true
      ? "type IN ('run.completed', 'run.failed', 'run.cancelled')"
      : "type = 'run.completed'";
  const row = await connection.get(
    `SELECT sequence, type, run_id, command_id, recorded_at, payload FROM events WHERE run_id = ? AND ${types} AND sequence <= ? ORDER BY sequence DESC LIMIT 1`,
    [cursor.runId, cursor.atOrBefore],
  );
  return row === undefined ? undefined : publishedEvents([row])[0];
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

async function workflowIds(
  connection: SqlConnection,
  runIds?: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  if (runIds?.length === 0) return {};
  const scoped =
    runIds === undefined
      ? ""
      : ` AND d.run_id IN (${runIds.map(() => "?").join(", ")})`;
  const rows = await connection.all(
    `SELECT d.run_id, json_extract(s.body, '$.workflowId') AS workflow_id FROM run_details d JOIN documents s ON s.digest = d.submission WHERE json_valid(s.body) AND json_type(s.body, '$.workflowId') = 'text'${scoped}`,
    runIds,
  );
  return Object.fromEntries(
    rows.map((row) => [text(row, "run_id"), text(row, "workflow_id")]),
  );
}

export type Read = <Value>(
  query: (connection: SqlConnection) => Promise<Value>,
) => Promise<Value>;

function cachedOrigins(read: Read): () => Promise<RunOrigins> {
  let sequence = 0;
  let origins: RunOrigins = {};
  let pending = Promise.resolve();
  return () => {
    const result = pending.then(() =>
      read(async (connection) => {
        const through = await latestSequence(connection);
        if (through === sequence) return origins;
        const added = await runOrigins(connection, {
          after: sequence,
          through,
        });
        if (Object.keys(added).length > 0) origins = { ...origins, ...added };
        sequence = through;
        return origins;
      }),
    );
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function guardedRead(access: {
  readonly reader: Database;
  readonly ready: () => Promise<void>;
}): Read {
  const { reader, ready } = access;
  return async (query) => {
    await ready();
    return reader.connection(query);
  };
}

export function authorityQueries(read: Read): AuthorityQueries {
  const origins = cachedOrigins(read);
  let linkedOrigins: RunOrigins | undefined;
  let links: Readonly<Record<string, RunLinks>> = {};
  const currentLinks = async () => {
    const current = await origins();
    if (current !== linkedOrigins) {
      links = runLinks(current);
      linkedOrigins = current;
    }
    return links;
  };
  return {
    run: (runId) => read((connection) => run(connection, runId)),
    manifest: (runId) =>
      read(async (connection) => {
        const row = await connection.get(
          "SELECT d.manifest FROM runs r JOIN definitions d ON d.pin = r.workflow WHERE r.run_id = ?",
          [runId],
        );
        return row === undefined
          ? undefined
          : readExecutionManifest(JSON.parse(text(row, "manifest")));
      }),
    document: (digest) =>
      read((connection) => documentBody(connection, digest)),
    receipt: (commandId) =>
      read((connection) => receipt(connection, commandId)),
    eventsAfter: (cursor) =>
      read((connection) => eventsAfter(connection, cursor)),
    latestCompletion: (cursor) =>
      read((connection) => latestCompletion(connection, cursor)),
    sequences: () => read(sequences),
    workflowIds: (runIds) =>
      read((connection) => workflowIds(connection, runIds)),
    runOrigins: origins,
    runLinks: currentLinks,
  };
}
