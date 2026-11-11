import type { Fields, ServiceError } from "../protocol.ts";
import { listRuns, send } from "./client.ts";
import { failed } from "./command-output.ts";
import type { CommandEnvironment } from "./commands.ts";
import { settingsEnvironment } from "./project-settings.ts";
import { clientCommand } from "./runtime-directory.ts";
import type { RuntimeInvocation } from "./runtime-invocation.ts";
import type { WatchMember } from "./watch-snapshot.ts";
import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { defaultWatchPort, workspaceWatchServer } from "./watch-server.ts";
import type { WorkspaceMember, WorkspaceRecord } from "./workspace-record.ts";
import { workspaceRestartCommand } from "./workspace-restart-command.ts";

export interface WorkspaceEnvironment extends CommandEnvironment {
  readonly workspace: WorkspaceRecord | undefined;
  readonly selected: string | undefined;
  readonly repository: string | undefined;
  readonly variables: Readonly<NodeJS.ProcessEnv>;
}

export type WorkspaceSummary =
  | {
      readonly name: string;
      readonly repository: string;
      readonly runtimeDirectory: string;
      readonly service: "up";
      readonly activeRuns: number;
      readonly pendingDecisions: number;
    }
  | {
      readonly name: string;
      readonly repository: string;
      readonly runtimeDirectory: string;
      readonly service: "down";
      readonly error: ServiceError;
    };

function listed(result: Fields, field: string): number {
  const value = result[field];
  return Array.isArray(value) ? value.length : 0;
}

export async function workspaceSummary(
  member: WorkspaceMember,
): Promise<WorkspaceSummary> {
  const place = {
    name: member.name,
    repository: member.repository,
    runtimeDirectory: member.runtime,
  };
  const questions = await send(member.runtime, {
    operation: "questions",
    parameters: {},
  });
  if (questions.kind === "error")
    return { ...place, service: "down", error: questions.error };
  const runs = await listRuns(member.runtime, { active: true });
  if (runs.kind === "error")
    return { ...place, service: "down", error: runs.error };
  return {
    ...place,
    service: "up",
    activeRuns: listed(runs.result, "runs"),
    pendingDecisions: listed(questions.result, "decisions"),
  };
}

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function summaryLine(shown: WorkspaceSummary): string {
  if (shown.service === "down")
    return `  ${shown.name}: service down, ${shown.error.code}\n`;
  return `  ${shown.name}: service up, ${counted(shown.activeRuns, "active run")}, ${counted(shown.pendingDecisions, "pending decision")}\n`;
}

async function workspaceStatus(
  environment: WorkspaceEnvironment,
  input: {
    readonly members: readonly WorkspaceMember[];
    readonly json: boolean;
  },
): Promise<number> {
  const summaries = await Promise.all(input.members.map(workspaceSummary));
  const { out } = environment.terminal;
  if (input.json)
    out(
      `${JSON.stringify({ schemaVersion: 1, kind: "workspace-status", repositories: summaries })}\n`,
    );
  else
    out(
      [
        "Workspace repositories:\n",
        ...summaries.map(summaryLine),
        "Run cloving status --repository <name> to show the runs of one repository.\n",
      ].join(""),
    );
  return summaries.every((shown) => shown.service === "up") ? 0 : 1;
}

function workspaceMembers(
  environment: WorkspaceEnvironment,
): readonly WorkspaceMember[] | undefined {
  const { workspace, selected, repository } = environment;
  if (workspace === undefined || selected !== undefined) return undefined;
  const outside =
    repository !== undefined &&
    !workspace.members.some((member) => member.repository === repository);
  return outside ? undefined : workspace.members;
}

function summaryMembers(
  invocation: Extract<RuntimeInvocation, { readonly kind: "status" }>,
  environment: WorkspaceEnvironment,
): readonly WorkspaceMember[] | undefined {
  const { runId, limit, after } = invocation;
  if (runId !== null || limit !== null || after !== null) return undefined;
  return workspaceMembers(environment);
}

export function watchMembers(
  workspace: WorkspaceRecord,
  settings: {
    readonly watchPr?: WatchPrSettings | undefined;
    readonly variables: Readonly<NodeJS.ProcessEnv>;
  },
): WatchMember[] {
  const { watchPr, variables } = settings;
  return workspace.members.map((member) => ({
    name: member.name,
    runtimeDirectory: member.runtime,
    client: clientCommand(variables, { repository: member.repository }),
    pullRequests: watchPr && {
      ...watchPr,
      repository: member.repository,
      githubCommand: settingsEnvironment(variables, member.repository)[
        "CLOVING_GH_COMMAND"
      ],
    },
  }));
}

function workspaceWatch(
  environment: WorkspaceEnvironment,
  port: number | null,
): Promise<number> {
  if (environment.workspace === undefined)
    return Promise.resolve(
      failed(environment, {
        error: {
          code: "workspace-not-running",
          detail: "Start the workspace with cloving start --workspace.",
        },
        format: { json: false },
      }),
    );
  return workspaceWatchServer({
    repositories: watchMembers(environment.workspace, environment),
    themes: environment.watchThemes,
    retentionDays: environment.retentionDays,
    port: port ?? defaultWatchPort,
    announce: environment.terminal.out,
    complain: environment.terminal.error,
    stopped: environment.interrupted(),
  });
}

export function workspaceCommand(
  invocation: RuntimeInvocation,
  environment: WorkspaceEnvironment,
): Promise<number> | undefined {
  if (invocation.kind === "watch" && invocation.workspace === true)
    return workspaceWatch(environment, invocation.port);
  if (invocation.kind === "restart")
    return workspaceMembers(environment) === undefined
      ? undefined
      : workspaceRestartCommand(invocation, environment);
  if (invocation.kind !== "status") return undefined;
  const members = summaryMembers(invocation, environment);
  if (members === undefined) return undefined;
  return workspaceStatus(environment, {
    members,
    json: invocation.json,
  });
}
