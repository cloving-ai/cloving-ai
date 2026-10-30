import { readCommandWaits } from "../command-wait-restore.ts";
import { parseCommand } from "../../authority/commands.ts";
import type { EffectIntent } from "../../authority/reducer.ts";
import { readExecutionManifest } from "../../execution-pin.ts";
import { operationScope } from "../../operation-identity.ts";
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
  optionalInteger,
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
  type Undigested,
} from "./delivery-intents.ts";
import { effectTurn, neighbours, pendingEffect } from "./effect-turn.ts";
import { stopIntents } from "./stop-plan.ts";
import { droppedRuns, turnStopping } from "./stop-turn.ts";
import { documentReferences, type TurnState } from "./turn-plan.ts";

export async function commandTurn(
  connection: SqlConnection,
  scope: {
    readonly command: unknown;
    readonly sequence: number;
    readonly capacity: number;
  },
): Promise<TurnState> {
  const { command, sequence, capacity } = scope;
  const parsed = parseCommand(command);
  return turnState(connection, {
    runId: parsed?.runId ?? "",
    commandId: parsed?.commandId ?? "",
    kind: parsed?.kind ?? "",
    sequence,
    references: documentReferences(parsed),
    operations: [parsed?.operationId]
      .filter((operationId) => operationId !== undefined)
      .filter(
        (operationId) => operationScope(operationId)?.run === parsed?.runId,
      ),
    keys: parsed?.resource === undefined ? [] : [parsed.resource],
    capacity,
  });
}

export async function stopRecoveries(
  connection: SqlConnection,
  rule: {
    readonly capacity: number;
    readonly stopLimit: number;
    readonly stopSupported: boolean;
  },
): Promise<readonly DeliveryIntent[]> {
  const intents: DeliveryIntent[] = [];
  const listed = await droppedRuns(connection, {
    limit: recoveryBatch,
    stopSupported: rule.stopSupported,
  });
  for (const runId of listed) {
    const turn = await turnState(connection, {
      runId,
      commandId: "",
      kind: "",
      sequence: 0,
      references: [],
      operations: [],
      keys: [],
      capacity: rule.capacity,
    });
    intents.push(
      ...stopIntents(turn.state, {
        ...rule,
        stopping: turn.stopping,
        runId,
        closed: [],
        cancelledNow: [],
        opening: true,
        rejected: new Set(),
      }),
    );
  }
  return intents;
}

export function recoveryTurn(
  connection: SqlConnection,
  scope: { readonly sequence: number; readonly capacity: number },
): Promise<TurnState> {
  return turnState(connection, {
    ...scope,
    runId: "",
    commandId: "",
    kind: "",
    references: [],
    operations: [],
    keys: [],
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
    "SELECT o.operation_id, o.kind, o.run_id, r.workflow FROM outbox o JOIN runs r ON r.run_id = o.run_id WHERE o.released_sequence IS NULL AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.operation_id = o.operation_id AND d.outcome IS NULL) AND ((o.kind = 'start-run' AND r.status = 'queued') OR (o.kind IN ('continue-run', 'resume-hook') AND r.status = 'running') OR (o.kind = 'protected-effect' AND r.status = 'running' AND EXISTS (SELECT 1 FROM operations p WHERE p.operation_id = o.operation_id AND p.status = 'dispatch-pending'))) ORDER BY o.created_sequence, o.rowid LIMIT ?",
    [recoveryBatch],
  );
  const intents: DeliveryIntent[] = [];
  for (const row of rows) {
    const intent = {
      kind: intentKind(text(row, "kind")),
      runId: text(row, "run_id"),
      operationId: text(row, "operation_id"),
      workflow: text(row, "workflow"),
    };
    intents.push(
      intent.kind === "protected-effect"
        ? await pendingEffect(connection, { intent, purpose: "dispatch" })
        : await runIntent(connection, intent),
    );
  }
  return [...intents, ...(await uncertainEffects(connection))];
}

async function uncertainEffects(
  connection: SqlConnection,
): Promise<readonly DeliveryIntent[]> {
  const rows = await connection.all(
    "SELECT p.operation_id, p.run_id, r.workflow FROM operations p JOIN runs r ON r.run_id = p.run_id WHERE p.status IN ('recovering', 'blocked') AND r.status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM command_waits w WHERE w.check_operation = p.operation_id AND w.state != 'waiting') AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.operation_id = p.operation_id AND d.outcome IS NULL) ORDER BY p.requested_sequence LIMIT ?",
    [recoveryBatch],
  );
  const intents: DeliveryIntent[] = [];
  for (const row of rows)
    intents.push(
      await pendingEffect(connection, {
        intent: {
          kind: "protected-effect",
          runId: text(row, "run_id"),
          operationId: text(row, "operation_id"),
          workflow: text(row, "workflow"),
        },
        purpose: "reconcile",
      }),
    );
  return intents;
}

async function runIntent(
  connection: SqlConnection,
  intent: Undigested,
): Promise<DeliveryIntent> {
  const gate = await connection.get(
    `SELECT ${gateColumns} FROM gates WHERE continuation = ?`,
    [intent.operationId],
  );
  return deliveryIntent({
    ...intent,
    ...gateDecision(gate === undefined ? undefined : storedGate(gateRow(gate))),
  });
}

export interface DeliveryTurn {
  readonly delivery: DeliveryRow;
  readonly runId: string;
  readonly intent: EffectIntent["kind"];
  readonly leaseGeneration: number | null;
  readonly purpose: string;
  readonly turn: TurnState;
}

export async function deliveryTurn(
  connection: SqlConnection,
  scope: {
    readonly effectId: string;
    readonly sequence: number;
    readonly capacity: number;
  },
): Promise<DeliveryTurn | undefined> {
  const { effectId, sequence, capacity } = scope;
  const found = await connection.get(
    "SELECT d.effect_id, d.operation_id, d.input_digest, d.staged_sequence, d.outcome, d.receipt, o.run_id, o.kind, a.lease_generation, coalesce(a.purpose, 'dispatch') AS purpose FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id LEFT JOIN dispatch_attempts a ON a.effect_id = d.effect_id WHERE d.effect_id = ?",
    [effectId],
  );
  if (found === undefined) return undefined;
  const runId = text(found, "run_id");
  return {
    delivery: deliveryRow(found),
    runId,
    intent: intentKind(text(found, "kind")),
    leaseGeneration: optionalInteger(found, "lease_generation"),
    purpose: text(found, "purpose"),
    turn: await turnState(connection, {
      runId,
      commandId: "",
      kind: "",
      sequence,
      references: [],
      operations: [text(found, "operation_id")],
      keys: [],
      capacity,
    }),
  };
}

async function attemptSets(
  connection: SqlConnection,
  runId: string,
): Promise<Pick<TurnState, "held" | "blocked">> {
  return {
    held: new Set(
      (
        await connection.all(
          "SELECT d.operation_id FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id WHERE o.run_id = ? AND (d.outcome IS NULL OR (d.outcome = 'blocked' AND d.rowid = (SELECT max(rowid) FROM deliveries WHERE operation_id = d.operation_id)))",
          [runId],
        )
      ).map((row) => text(row, "operation_id")),
    ),
    blocked: new Map(
      (
        await connection.all(
          "SELECT d.operation_id, d.effect_id FROM deliveries d JOIN outbox o ON o.operation_id = d.operation_id WHERE o.run_id = ? AND d.outcome = 'blocked' AND d.rowid = (SELECT max(rowid) FROM deliveries WHERE operation_id = d.operation_id)",
          [runId],
        )
      ).map((row) => [text(row, "operation_id"), text(row, "effect_id")]),
    ),
  };
}

interface Scope {
  readonly runId: string;
  readonly commandId: string;
  readonly kind: string;
  readonly sequence: number;
  readonly references: readonly string[];
  readonly operations: readonly string[];
  readonly keys: readonly string[];
  readonly capacity: number;
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
  const effects = await effectTurn(connection, scope);
  const near = await neighbours(connection, { runId, effects });
  const decisions = decisionState(await runDecisions(connection, runId));
  const own = await intents(connection, {
    sql: "SELECT operation_id, kind, run_id, created_sequence, released_sequence FROM outbox WHERE run_id = ? AND released_sequence IS NULL ORDER BY created_sequence, rowid",
    parameters: [runId],
  });
  const waits = await readCommandWaits(connection, runId);
  return {
    state: {
      ...waits,
      sequence,
      runs: { ...near.runs, ...(stored ? { [runId]: stored } : {}) },
      commands: recorded ? { [commandId]: recorded } : {},
      intents: [...own, ...near.intents],
      ...decisions,
      details: { ...near.details, ...decisions.details },
      effects,
    },
    documents: new Set(await storedDigests(connection, scope.references)),
    definitions: await definitions(connection, stored?.workflow),
    ...(await attemptSets(connection, runId)),
    stopping: await turnStopping(connection, {
      runId,
      status: stored?.status,
      kind: scope.kind,
      ...waits,
    }),
    runId,
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
