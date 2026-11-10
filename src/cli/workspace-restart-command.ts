import { dirname } from "node:path";
import { record, type Fields } from "../protocol.ts";
import { mutate } from "./client.ts";
import {
  failed,
  identified,
  type OutputEnvironment,
} from "./command-output.ts";
import type { RestartInvocation } from "./restart-arguments.ts";
import { show } from "./terminal-text.ts";
import { workspaceRecordPath } from "./workspace-record.ts";

export interface WorkspaceRestartEnvironment extends OutputEnvironment {
  readonly variables: Readonly<NodeJS.ProcessEnv>;
  readonly interrupted: () => Promise<void>;
}

function unsupported(invocation: RestartInvocation): string | undefined {
  if (invocation.update) return "--update";
  if (invocation.cancel) return "--cancel";
  return invocation.within === null ? undefined : "--within";
}

function restartedLines(result: Fields): string {
  const repositories = Array.isArray(result["repositories"])
    ? result["repositories"].map((value: unknown) => record(value) ?? {})
    : [];
  return [
    "The workspace restarted all repositories:\n",
    ...repositories.map(
      (repository) =>
        `  ${show(repository["name"])}: service started at ${show(repository["serviceStartedAt"])}\n`,
    ),
  ].join("");
}

export async function workspaceRestartCommand(
  invocation: RestartInvocation,
  environment: WorkspaceRestartEnvironment,
): Promise<number> {
  const option = unsupported(invocation);
  if (option !== undefined)
    return failed(environment, {
      error: {
        code: "workspace-restart-option",
        detail: `A workspace restart has no ${option}. Use --repository <name> to restart one repository.`,
      },
      format: { json: invocation.json },
    });
  const format = identified(environment, invocation);
  const folder = dirname(String(workspaceRecordPath(environment.variables)));
  const reply = await mutate(folder, {
    request: {
      operation: "restart",
      parameters: {
        commandId: format.commandId,
        at: invocation.at,
        ...(invocation.resumeQueue ? { resumeQueue: true } : {}),
        ...(invocation.settings === "files" ? { settings: "files" } : {}),
      },
    },
    signal: environment.interrupted(),
  });
  if (reply.kind === "error")
    return failed(environment, { error: reply.error, format });
  environment.terminal.out(
    invocation.json
      ? `${JSON.stringify({ schemaVersion: 1, ...reply.result })}\n`
      : restartedLines(reply.result),
  );
  return 0;
}
