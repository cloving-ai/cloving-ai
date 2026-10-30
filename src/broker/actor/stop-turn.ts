import type {
  AttemptSummary,
  StopSubject,
} from "../../authority/stop-sequence.ts";
import type { CommandWaitsState } from "../../authority/command-waits.ts";
import {
  integer,
  optionalInteger,
  optionalText,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";

export interface Stopping {
  readonly subjects: readonly StopSubject[];
  readonly cancelledSequence: number | null;
}

export const noStopping: Stopping = { subjects: [], cancelledSequence: null };

function attemptOf(row: unknown): AttemptSummary {
  return {
    effectId: text(row, "effect_id"),
    purpose: text(row, "purpose"),
    outcome: optionalText(row, "outcome"),
    stagedSequence: integer(row, "staged_sequence"),
  };
}

const closed =
  "NOT EXISTS (SELECT 1 FROM deliveries x WHERE x.operation_id = o.operation_id AND x.outcome IS NULL)";
const reported =
  "EXISTS (SELECT 1 FROM stopped_operations s WHERE s.operation_id = o.operation_id)";
const finalStatuses =
  "'refused', 'completed', 'failed', 'stopped', 'cancelled'";
const waitStopSequence =
  "(SELECT min(e.sequence) FROM command_waits w JOIN events e ON e.run_id = w.run_id WHERE w.check_operation = o.operation_id AND w.state != 'waiting' AND (e.type IN ('run.completed', 'run.failed', 'run.cancelled') OR (json_extract(e.payload, '$.waitName') = w.name AND (e.type = 'command-wait.expired' OR (e.type = 'command-wait.opened' AND round(unixepoch(e.recorded_at, 'subsec') * 1000) >= w.deadline)))))";

export async function stopping(
  connection: SqlConnection,
  runId: string,
): Promise<Stopping> {
  const rows = await connection.all(
    `SELECT o.operation_id, o.kind, d.effect_id, coalesce(a.purpose, 'dispatch') AS purpose, d.outcome, d.staged_sequence, p.status, p.receipt, ${reported} AS stopped, ${waitStopSequence} AS stop_sequence FROM outbox o JOIN deliveries d ON d.operation_id = o.operation_id LEFT JOIN dispatch_attempts a ON a.effect_id = d.effect_id LEFT JOIN operations p ON p.operation_id = o.operation_id WHERE o.run_id = ? AND ((coalesce(p.status, '') NOT IN (${finalStatuses}) AND NOT ${reported}) OR NOT ${closed}) ORDER BY d.staged_sequence, d.rowid`,
    [runId],
  );
  const grouped = Map.groupBy(rows, (row) => text(row, "operation_id"));
  return {
    subjects: [...grouped].map(([operationId, attempts]) => {
      const stopSequence = optionalInteger(attempts[0], "stop_sequence");
      return {
        operationId,
        kind: text(attempts[0], "kind"),
        attempts: attempts.map(attemptOf),
        status: optionalText(attempts[0], "status"),
        receipt: optionalText(attempts[0], "receipt"),
        stopped: integer(attempts[0], "stopped") === 1,
        ...(stopSequence === null ? {} : { stopSequence }),
      };
    }),
    cancelledSequence: optionalInteger(
      await connection.get(
        "SELECT max(sequence) AS sequence FROM events WHERE run_id = ? AND type = 'run.cancelled'",
        [runId],
      ),
      "sequence",
    ),
  };
}

export function turnStopping(
  connection: SqlConnection,
  scope: {
    readonly runId: string;
    readonly status: string | undefined;
    readonly kind: string;
    readonly commandWaits?: CommandWaitsState;
  },
): Promise<Stopping> {
  const endingWait = Object.values(scope.commandWaits ?? {}).some(
    (wait) =>
      wait.checkOperation !== null &&
      (wait.state !== "waiting" ||
        [
          "expire-command-wait",
          "open-command-wait",
          "complete-run",
          "fail-run",
        ].includes(scope.kind)),
  );
  const dropping =
    scope.status === "cancelled" || scope.kind === "cancel-run" || endingWait;
  return dropping
    ? stopping(connection, scope.runId)
    : Promise.resolve(noStopping);
}

const sent =
  "EXISTS (SELECT 1 FROM deliveries d WHERE d.operation_id = o.operation_id AND d.outcome = 'sent')";
const last =
  "(SELECT d.outcome FROM deliveries d WHERE d.operation_id = o.operation_id ORDER BY d.staged_sequence DESC, d.rowid DESC LIMIT 1)";
const effectDue = `o.kind = 'protected-effect' AND p.status NOT IN (${finalStatuses}) AND (p.receipt IS NULL OR ?1 = 1 OR p.status IN ('recovering', 'blocked'))`;
const runDue = `o.kind != 'protected-effect' AND NOT ${reported} AND ((${sent} AND ?1 = 1) OR (NOT ${sent} AND ${last} NOT IN ('withheld', 'blocked', 'absent')))`;

export async function droppedRuns(
  connection: SqlConnection,
  rule: { readonly limit: number; readonly stopSupported: boolean },
): Promise<readonly string[]> {
  const rows = await connection.all(
    `SELECT r.run_id FROM runs r WHERE EXISTS (SELECT 1 FROM outbox o LEFT JOIN operations p ON p.operation_id = o.operation_id WHERE o.run_id = r.run_id AND (r.status = 'cancelled' OR EXISTS (SELECT 1 FROM command_waits w WHERE w.run_id = r.run_id AND w.check_operation = o.operation_id AND w.state != 'waiting')) AND ${closed} AND ((${effectDue}) OR (${runDue}))) ORDER BY r.run_id LIMIT ?2`,
    [rule.stopSupported ? 1 : 0, rule.limit],
  );
  return rows.map((row) => text(row, "run_id"));
}
