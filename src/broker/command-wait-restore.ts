import type { Database } from "solid-objects";
import {
  commandWaitKey,
  type CommandWaitState,
  type CommandWaitsState,
} from "../authority/command-waits.ts";
import { operationPhase } from "../operation-identity.ts";
import { documentDigest } from "./decision-restore.ts";
import type { AuthorityEvent } from "../authority/transitions.ts";
import { readExecutionManifest } from "../execution-pin.ts";
import { text } from "../storage/domain-rows.ts";
import type { DispatchRead } from "../authority/dispatch-decision.ts";
import type { AuthorityState } from "../authority/transitions.ts";
import {
  commandWaitStatements,
  loadCommandWaits,
  type CommandWaitRow,
} from "../storage/command-wait-rows.ts";
import type { SqlConnection } from "../storage/domain-rows.ts";
import {
  checkedVersion,
  waitingVersion,
  upgradeSchema,
} from "../storage/domain-schema.ts";

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
    const state = [
      "waiting",
      "timed-out",
      "cancelled",
      "completed",
      "failed",
    ] as const;
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
  return commandWaitState(await loadCommandWaits(connection, { runId }));
}

export async function upgradeCommandWaits(
  database: Database,
  state: AuthorityState,
): Promise<void> {
  await database.transaction(async (connection) => {
    await upgradeSchema(connection, waitingVersion);
    for (const statement of commandWaitStatements(
      commandWaitRows(state.commandWaits ?? {}),
      { version: "opened" },
    ))
      await connection.run(statement.sql, statement.parameters);
  });
}

export async function upgradeCommandWaitChecks(
  database: Database,
): Promise<void> {
  await database.transaction(async (connection) => {
    await upgradeSchema(connection, checkedVersion);
  });
}

export function commandWaitDeadline(
  waits: CommandWaitsState,
  operationId: string,
): { readonly commandDeadline?: string } {
  const wait = Object.values(waits).find(
    (wait) => wait.checkOperation === operationId,
  );
  return wait === undefined
    ? {}
    : { commandDeadline: new Date(wait.deadline).toISOString() };
}

export async function dispatchCommandWait(
  connection: SqlConnection,
  check: {
    readonly runId: string;
    readonly workflow: string;
    readonly operationId: string;
  },
): Promise<Pick<DispatchRead, "commandWait">> {
  if (operationPhase(check.operationId) !== "command-wait") return {};
  const state = await readCommandWaits(connection, check.runId);
  const wait = Object.values(state.commandWaits ?? {}).find(
    (wait) => wait.checkOperation === check.operationId,
  );
  if (wait === undefined) return {};
  const row = await connection.get(
    "SELECT manifest FROM definitions WHERE pin = ?",
    [check.workflow],
  );
  const declarations =
    readExecutionManifest(JSON.parse(text(row, "manifest"))).commandWaits ?? {};
  const permission = Object.hasOwn(declarations, wait.name)
    ? declarations[wait.name]
    : undefined;
  return { commandWait: { wait, declared: declaredWait(wait, permission) } };
}

function declaredWait(
  wait: CommandWaitState,
  permission:
    | {
        readonly command: string;
        readonly maximumWaitSeconds: number;
        readonly pollEverySeconds: number;
      }
    | undefined,
): boolean {
  return (
    permission !== undefined &&
    permission.command === wait.command &&
    permission.maximumWaitSeconds === wait.maximumWaitSeconds &&
    permission.pollEverySeconds === wait.pollEverySeconds
  );
}

export function commandOutputsIntact(
  events: readonly AuthorityEvent[],
): boolean {
  return events.every((event) => {
    const output = event.payload["commandOutput"];
    return (
      output === undefined ||
      (event.payload["worker"] === "command" &&
        documentDigest(output) === event.payload["result"])
    );
  });
}

export async function readCommandWaitDeadline(
  connection: SqlConnection,
  scope: { readonly runId: string; readonly operationId: string },
): Promise<{ readonly commandDeadline?: string }> {
  if (operationPhase(scope.operationId) !== "command-wait") return {};
  const state = await readCommandWaits(connection, scope.runId);
  return commandWaitDeadline(state.commandWaits ?? {}, scope.operationId);
}
