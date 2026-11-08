import { readFile } from "node:fs/promises";
import { parseWorkspace, workspaceFile, type Workspace } from "../workspace.ts";
import { runtimeDirectory } from "./runtime-directory.ts";
import {
  liveWorkspace,
  removeWorkspaceRecord,
  workspaceRecordPath,
  writeWorkspaceRecord,
  type WorkspaceMember,
} from "./workspace-record.ts";

export interface WorkspaceHost {
  readonly repository: string;
  readonly runtime: string;
  readonly options: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface WorkspaceWatch {
  readonly port: string;
  readonly signal: AbortSignal;
}

export interface WorkspaceStart {
  readonly options: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly processId: number;
  readonly repositoryDirectory: (directory: string) => string | undefined;
  readonly hosted: (host: WorkspaceHost) => Promise<number>;
  readonly watched: (watch: WorkspaceWatch) => Promise<number>;
  readonly print: (text: string) => void;
  readonly refuse: (text: string) => void;
}

type Member = WorkspaceMember;

const runtimeUnknown =
  "workspace-runtime-unknown: Set HOME, XDG_STATE_HOME or XDG_RUNTIME_DIR.";

type Members =
  | { readonly kind: "members"; readonly members: readonly Member[] }
  | { readonly kind: "refused"; readonly text: string };

function refusal(text: string): Members {
  return { kind: "refused", text: `${text}\n` };
}

function sharedMember(
  members: readonly Member[],
  key: "repository" | "runtime",
): readonly [Member, Member] | undefined {
  for (const [index, member] of members.entries()) {
    const other = members
      .slice(0, index)
      .find((earlier) => earlier[key] === member[key]);
    if (other !== undefined) return [other, member];
  }
  return undefined;
}

function located(
  workspace: Workspace,
  input: Pick<WorkspaceStart, "environment" | "repositoryDirectory">,
): Members {
  const members: Member[] = [];
  for (const { name, path } of workspace.repositories) {
    const repository = input.repositoryDirectory(path);
    if (repository === undefined)
      return refusal(
        `workspace-repository-unknown: ${name}: ${path} is not a git repository.`,
      );
    const runtime = runtimeDirectory(input.environment, repository);
    if (runtime === undefined) return refusal(runtimeUnknown);
    members.push({ name, repository, runtime });
  }
  const repeated = sharedMember(members, "repository");
  if (repeated !== undefined)
    return refusal(
      `workspace-repository-duplicate: ${repeated[0].name} and ${repeated[1].name} name the same repository ${repeated[0].repository}.`,
    );
  const shared = sharedMember(members, "runtime");
  if (shared !== undefined)
    return refusal(
      `workspace-runtime-shared: ${shared[0].name} and ${shared[1].name} use the same runtime directory ${shared[0].runtime}. Unset CLOVING_RUNTIME_DIR.`,
    );
  return { kind: "members", members };
}

async function workspaceMembers(
  input: WorkspaceStart,
  file: string,
): Promise<Members> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined)
    return refusal(
      `workspace-missing: Cloving cannot read ${file}. Write the workspace file first. See cloving start --help.`,
    );
  let workspace: Workspace;
  try {
    workspace = parseWorkspace(text);
  } catch (error) {
    return refusal(
      `${error instanceof Error ? error.message : "invalid-workspace"}.`,
    );
  }
  return located(workspace, input);
}

async function memberStatus(input: {
  readonly member: Member;
  readonly start: WorkspaceStart;
  readonly stopping: AbortController;
}): Promise<number> {
  const { member, start, stopping } = input;
  let status: number | undefined;
  try {
    status = await start.hosted({
      repository: member.repository,
      runtime: member.runtime,
      options: start.options,
      environment: { ...start.environment, CLOVING_WATCH_PORT: "off" },
      signal: stopping.signal,
    });
    if (status !== 0 && !stopping.signal.aborted)
      start.refuse(
        `workspace-repository-ended: ${member.name} ended with status ${String(status)}. Cloving stops the other repositories.\n`,
      );
    return status;
  } finally {
    if (status !== 0) stopping.abort();
  }
}

async function supervised(
  input: WorkspaceStart,
  members: readonly Member[],
): Promise<number> {
  const stopping = new AbortController();
  const watching = new AbortController();
  const port = input.environment["CLOVING_WATCH_PORT"] ?? "3663";
  const watch =
    port === "off"
      ? Promise.resolve(0)
      : input.watched({ port, signal: watching.signal });
  const statuses = await Promise.all(
    members.map((member) => memberStatus({ member, start: input, stopping })),
  );
  watching.abort();
  await watch;
  return statuses.every((status) => status === 0) ? 0 : 1;
}

function recordRefusal(input: WorkspaceStart): string | undefined {
  if (workspaceRecordPath(input.environment) === undefined)
    return `${runtimeUnknown}\n`;
  const running = liveWorkspace(input.environment);
  return running === undefined
    ? undefined
    : `workspace-already-running: The workspace supervisor with process ID ${String(running.processId)} runs. Stop it first.\n`;
}

export async function workspaceStart(input: WorkspaceStart): Promise<number> {
  const file = workspaceFile(input.environment, input.home);
  const found = await workspaceMembers(input, file);
  if (found.kind === "refused") {
    input.refuse(found.text);
    return 1;
  }
  const refused = recordRefusal(input);
  if (refused !== undefined) {
    input.refuse(refused);
    return 1;
  }
  input.print(
    [
      `Cloving workspace: ${file}`,
      ...found.members.map(
        (member) => `  ${member.name}: ${member.repository}`,
      ),
      "",
    ].join("\n"),
  );
  const path = String(workspaceRecordPath(input.environment));
  await writeWorkspaceRecord(path, {
    processId: input.processId,
    members: found.members,
  });
  try {
    return await supervised(input, found.members);
  } finally {
    await removeWorkspaceRecord(path, input.processId);
  }
}
