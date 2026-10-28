import type { Database } from "solid-objects";
import {
  commandWaitKey,
  type CommandWaitsState,
} from "../authority/command-waits.ts";
import type { AuthorityState } from "../authority/transitions.ts";
import {
  commandWaitStatements,
  loadCommandWaits,
  type CommandWaitRow,
} from "../storage/command-wait-rows.ts";
import type { SqlConnection } from "../storage/domain-rows.ts";
import { currentVersion, upgradeSchema } from "../storage/domain-schema.ts";

export function commandWaitRows(
  waits: CommandWaitsState,
): readonly CommandWaitRow[] {
  return Object.values(waits).sort((left, right) => {
    if (left.runId !== right.runId) return left.runId < right.runId ? -1 : 1;
    return left.name < right.name ? -1 : 1;
  });
}

export function commandWaitState(rows: readonly CommandWaitRow[]): {
  readonly commandWaits?: CommandWaitsState;
} {
  const waits: Record<string, CommandWaitsState[string]> = {};
  for (const row of rows) {
    const state = ["waiting", "timed-out", "cancelled"] as const;
    const kind = state.find((candidate) => candidate === row.state);
    if (kind === undefined) throw new Error("invalid-command-wait-state");
    waits[commandWaitKey(row.runId, row.name)] = { ...row, state: kind };
  }
  return rows.length === 0 ? {} : { commandWaits: waits };
}

export async function readCommandWaits(
  connection: SqlConnection,
  runId: string,
): Promise<{ readonly commandWaits?: CommandWaitsState }> {
  return commandWaitState(await loadCommandWaits(connection, runId));
}

export async function upgradeCommandWaits(
  database: Database,
  state: AuthorityState,
): Promise<void> {
  await database.transaction(async (connection) => {
    await upgradeSchema(connection, currentVersion);
    for (const statement of commandWaitStatements(
      commandWaitRows(state.commandWaits ?? {}),
    ))
      await connection.run(statement.sql, statement.parameters);
  });
}
