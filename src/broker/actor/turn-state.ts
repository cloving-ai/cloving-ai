import { parseCommand } from "../../authority/commands.ts";
import type { EffectIntent } from "../../authority/reducer.ts";
import { readExecutionManifest } from "../../execution-pin.ts";
import {
  gateColumns,
  gateRow,
  runDecisions,
  storedDigests,
} from "../../storage/decision-rows.ts";
import {
  deliveryRow,
  integer,
  latestSequence,
  outboxRow,
  runRow,
  text,
  type DeliveryRow,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { authorityIdentity } from "../../storage/domain-schema.ts";
import { intentKind, storedRun } from "../authority-restore.ts";
import { decisionState, storedGate } from "../decision-restore.ts";
import {
  deliveryIntent,
  gateDecision,
  type DeliveryIntent,
} from "./delivery-intents.ts";
import { documentReferences, type TurnState } from "./turn-plan.ts";

export async function commandTurn(
  connection: SqlConnection,
  scope: { readonly command: unknown; readonly sequence: number },
): Promise<TurnState> {
  const { command, sequence } = scope;
  const parsed = parseCommand(command);
  return turnState(connection, {
    runId: parsed?.runId ?? "",
    commandId: parsed?.commandId ?? "",
    sequence,
    references: documentReferences(parsed),
  });
}

export const recoveryBatch = 100;

export async function adoptionTurn(connection: SqlConnection): Promise<number> {
  const identity = await authorityIdentity(connection);
  const latest = await latestSequence(connection);
  if (identity.pendingAdoption !== latest)
    throw new Error("adoption-not-pending");
  return latest;
}

export async function recoverableIntents(
  connection: SqlConnection,
): Promise<readonly DeliveryIntent[]> {
  const rows = await connection.all(
    "SELECT o.operation_id, o.kind, o.run_id, r.workflow FROM outbox o JOIN runs r ON r.run_id = o.run_id WHERE o.released_sequence IS NULL AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.operation_id = o.operation_id AND d.outcome IS NULL) AND ((o.kind = 'start-run' AND r.status = 'queued') OR (o.kind = 'continue-run' AND r.status = 'running')) ORDER BY o.created_sequence, o.rowid LIMIT ?",
    [recoveryBatch],
  );
  const intents: DeliveryIntent[] = [];
  for (const row of rows) {
    const operationId = text(row, "operation_id");
    const gate = await connection.get(
      `SELECT ${gateColumns} FROM gates WHERE continuation = ?`,
      [operationId],
    );
    intents.push(
      deliveryIntent({
        kind: intentKind(text(row, "kind")),
        runId: text(row, "run_id"),
        operationId,
        workflow: text(row, "workflow"),
        ...gateDecision(
          gate === undefined ? undefined : storedGate(gateRow(gate)),
        ),
      }),
    );
  }
  return intents;
}

export interface DeliveryTurn {
  readonly delivery: DeliveryRow;
  readonly runId: string;
  readonly turn: TurnState;
}

export async function deliveryTurn(
  connection: SqlConnection,
  scope: { readonly effectId: string; readonly sequence: number },
): Promise<DeliveryTurn | undefined> {
  const { effectId, sequence } = scope;
  const found = await connection.get(
    "SELECT d.effect_id, d.operation_id, d.input_digest, d.staged_sequence, d.outcome, d.receipt, o.run_id FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id WHERE d.effect_id = ?",
    [effectId],
  );
  if (found === undefined) return undefined;
  const runId = text(found, "run_id");
  return {
    delivery: deliveryRow(found),
    runId,
    turn: await turnState(connection, {
      runId,
      commandId: "",
      sequence,
      references: [],
    }),
  };
}

interface Scope {
  readonly runId: string;
  readonly commandId: string;
  readonly sequence: number;
  readonly references: readonly string[];
}

async function turnState(
  connection: SqlConnection,
  scope: Scope,
): Promise<TurnState> {
  const { runId, commandId, sequence } = scope;
  const run = await connection.get(
    "SELECT run_id, status, revision, workflow, paused_from, gates, sequence FROM runs WHERE run_id = ?",
    [runId],
  );
  const stored = run === undefined ? undefined : storedRun(runRow(run));
  const existing = await connection.get(
    "SELECT request, sequence FROM commands WHERE command_id = ?",
    [commandId],
  );
  const recorded =
    existing === undefined
      ? undefined
      : {
          request: text(existing, "request"),
          sequence: integer(existing, "sequence"),
        };
  return {
    state: {
      sequence,
      runs: stored ? { [runId]: stored } : {},
      commands: recorded ? { [commandId]: recorded } : {},
      intents: await intents(connection, {
        sql: "SELECT operation_id, kind, run_id, created_sequence, released_sequence FROM outbox WHERE run_id = ? AND released_sequence IS NULL ORDER BY created_sequence, rowid",
        parameters: [runId],
      }),
      ...decisionState(await runDecisions(connection, runId)),
    },
    documents: new Set(await storedDigests(connection, scope.references)),
    definitions: await definitions(connection, stored?.workflow),
    held: new Set(
      (
        await connection.all(
          "SELECT d.operation_id FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id WHERE o.run_id = ? AND (d.outcome IS NULL OR (d.outcome = 'blocked' AND d.rowid = (SELECT max(rowid) FROM deliveries WHERE operation_id = d.operation_id)))",
          [runId],
        )
      ).map((row) => text(row, "operation_id")),
    ),
    created: recorded
      ? await intents(connection, {
          sql: "SELECT operation_id, kind, run_id, created_sequence, released_sequence FROM outbox WHERE created_sequence = ? ORDER BY rowid",
          parameters: [recorded.sequence],
        })
      : [],
  };
}

async function intents(
  connection: SqlConnection,
  query: { readonly sql: string; readonly parameters: readonly unknown[] },
): Promise<readonly EffectIntent[]> {
  return (await connection.all(query.sql, query.parameters)).map((row) => {
    const intent = outboxRow(row);
    return {
      kind: intentKind(intent.kind),
      runId: intent.runId,
      operationId: intent.operationId,
    };
  });
}

async function definitions(
  connection: SqlConnection,
  pin: string | undefined,
): Promise<TurnState["definitions"]> {
  if (pin === undefined) return new Map();
  const row = await connection.get(
    "SELECT manifest FROM definitions WHERE pin = ?",
    [pin],
  );
  return new Map([
    [pin, readExecutionManifest(JSON.parse(text(row, "manifest")))],
  ]);
}
