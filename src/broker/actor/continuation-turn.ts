import { continuationOf } from "../../authority/continuations.ts";
import type { Continuations, EffectState } from "../../authority/operations.ts";
import type { RunState } from "../../authority/reducer.ts";
import type { AuthorityCommand } from "../../authority/transitions.ts";
import { operationOfRun } from "../../operation-identity.ts";
import {
  optionalText,
  runRow,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { storedRun } from "../authority-restore.ts";
import {
  effectTurn,
  neighbours,
  type EffectScope,
  type Neighbours,
} from "./effect-turn.ts";

export interface ContinuationTurn {
  readonly continuations?: Continuations;
  readonly operations: readonly string[];
  readonly runs: Readonly<Record<string, RunState>>;
}

interface Scope {
  readonly runId: string;
  readonly operations: readonly string[];
  readonly continuedFrom?: string;
}

const admission =
  "SELECT json_extract(payload, '$.continuedFrom') AS continued_from, json_extract(payload, '$.reuseBefore') AS reuse_before FROM events WHERE run_id = ? AND type = 'run.created'";

const continuing =
  "SELECT run_id, json_extract(payload, '$.reuseBefore') AS reuse_before FROM events WHERE type = 'run.created' AND json_extract(payload, '$.continuedFrom') = ?";

async function existingContinuations(
  connection: SqlConnection,
  runId: string | undefined,
): Promise<{ readonly continuations?: Continuations }> {
  if (runId === undefined) return {};
  const rows = await connection.all(continuing, [runId]);
  if (rows.length === 0) return {};
  return {
    continuations: Object.fromEntries(
      rows.map((row) => [
        text(row, "run_id"),
        { runId, before: Number(text(row, "reuse_before")) },
      ]),
    ),
  };
}

async function storedRuns(
  connection: SqlConnection,
  runId: string | undefined,
): Promise<Readonly<Record<string, RunState>>> {
  if (runId === undefined) return {};
  const row = await connection.get(
    "SELECT run_id, status, revision, workflow, paused_from, gates, sequence FROM runs WHERE run_id = ?",
    [runId],
  );
  return row === undefined ? {} : { [runId]: storedRun(runRow(row)) };
}

export async function continuationTurn(
  connection: SqlConnection,
  scope: Scope,
): Promise<ContinuationTurn> {
  const runs = await storedRuns(connection, scope.continuedFrom);
  const existing = await existingContinuations(connection, scope.continuedFrom);
  const row = await connection.get(admission, [scope.runId]);
  const continuedFrom =
    row === undefined ? null : optionalText(row, "continued_from");
  const reuseBefore =
    row === undefined ? null : optionalText(row, "reuse_before");
  const continuation =
    continuedFrom === null || reuseBefore === null
      ? undefined
      : continuationOf({ continuedFrom, reuseBefore });
  if (continuation === undefined) return { ...existing, operations: [], runs };
  return {
    continuations: { ...existing.continuations, [scope.runId]: continuation },
    operations: scope.operations
      .map((operationId) => operationOfRun(operationId, continuation.runId))
      .filter((operationId) => operationId !== null),
    runs,
  };
}

export function continuedFromOf(command: AuthorityCommand | null): {
  readonly continuedFrom?: string;
} {
  const continuedFrom = command?.continuedFrom;
  return continuedFrom === undefined ? {} : { continuedFrom };
}

export async function effectParts(
  connection: SqlConnection,
  scope: EffectScope & { readonly continuedFrom?: string },
): Promise<{
  readonly effects: EffectState;
  readonly near: Neighbours;
  readonly continuations?: Continuations;
}> {
  const continued = await continuationTurn(connection, scope);
  const effects = await effectTurn(connection, {
    ...scope,
    operations: [...scope.operations, ...continued.operations],
  });
  const near = await neighbours(connection, { runId: scope.runId, effects });
  return {
    effects,
    near: { ...near, runs: { ...continued.runs, ...near.runs } },
    ...(continued.continuations === undefined
      ? {}
      : { continuations: continued.continuations }),
  };
}
