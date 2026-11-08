import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseWorkspace, workspaceFile, type Workspace } from "../workspace.ts";
import { adoptionRecordPath, runtimeDirectory } from "./runtime-directory.ts";
import {
  claimWorkspaceRecord,
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
  readonly overrides: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface WorkspaceWatch {
  readonly port: string;
  readonly signal: AbortSignal;
}

export interface WatchRestart {
  readonly delayMilliseconds: number;
  readonly limit: number;
}

export interface WorkspaceStart {
  readonly options: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly processId: number;
  readonly repositoryDirectory: (directory: string) => string | undefined;
  readonly hosted: (host: WorkspaceHost) => Promise<number>;
  readonly watched: (watch: WorkspaceWatch) => Promise<number>;
  readonly watchRestart?: WatchRestart;
  readonly print: (text: string) => void;
  readonly refuse: (text: string) => void;
}

type Member = WorkspaceMember;

const runtimeUnknown =
  "workspace-runtime-unknown: Set HOME, XDG_STATE_HOME or XDG_RUNTIME_DIR.";

const watchRestart: WatchRestart = { delayMilliseconds: 1000, limit: 5 };

const settleMilliseconds = 200;

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
      environment: start.environment,
      overrides: { CLOVING_WATCH_PORT: "off" },
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

interface Settling {
  readonly path: string;
  readonly members: readonly Member[];
  readonly ended: ReadonlySet<Member>;
  readonly signal: AbortSignal;
}

function settled(environment: NodeJS.ProcessEnv, member: Member): boolean {
  const adoption = adoptionRecordPath(environment, member.repository);
  return (
    existsSync(join(member.runtime, "control.sock")) ||
    (adoption !== undefined && existsSync(adoption))
  );
}

async function settledMembers(
  input: WorkspaceStart,
  settling: Settling,
): Promise<boolean> {
  const waiting = (member: Member): boolean =>
    !settling.ended.has(member) && !settled(input.environment, member);
  while (settling.members.some(waiting))
    await delay(settleMilliseconds, undefined, { signal: settling.signal });
  return !settling.signal.aborted;
}

async function watchedPage(
  input: WorkspaceStart,
  watch: WorkspaceWatch,
): Promise<number> {
  const restart = input.watchRestart ?? watchRestart;
  for (let ended = 1; ; ended += 1) {
    const status = await input.watched(watch);
    if (watch.signal.aborted || status === 0) return 0;
    if (ended > restart.limit) {
      input.refuse(
        `workspace-watch-stopped: The watch page ended with status ${String(status)} ${String(ended)} times. The repositories keep running with no watch page.\n`,
      );
      return 1;
    }
    input.refuse(
      `workspace-watch-ended: The watch page ended with status ${String(status)}. Cloving starts it again.\n`,
    );
    await delay(restart.delayMilliseconds, undefined, { signal: watch.signal });
  }
}

async function settledWatch(
  input: WorkspaceStart,
  settling: Settling,
): Promise<number> {
  if (!(await settledMembers(input, settling))) return 0;
  await writeWorkspaceRecord(settling.path, {
    processId: input.processId,
    members: settling.members.map((member) => ({
      ...member,
      runtime:
        runtimeDirectory(input.environment, member.repository) ??
        member.runtime,
    })),
  });
  const port = input.environment["CLOVING_WATCH_PORT"] ?? "3663";
  if (port === "off") return 0;
  return watchedPage(input, { port, signal: settling.signal });
}

async function supervised(
  input: WorkspaceStart,
  workspace: Pick<Settling, "path" | "members">,
): Promise<number> {
  const stopping = new AbortController();
  const watching = new AbortController();
  const ended = new Set<Member>();
  const watch = settledWatch(input, {
    ...workspace,
    ended,
    signal: watching.signal,
  }).catch((error: unknown) => {
    if (watching.signal.aborted) return 0;
    input.refuse(
      `workspace-watch-failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  });
  const statuses = await Promise.all(
    workspace.members.map((member) =>
      memberStatus({ member, start: input, stopping }).finally(() => {
        ended.add(member);
      }),
    ),
  );
  watching.abort();
  const watchStatus = await watch;
  return statuses.every((status) => status === 0) && watchStatus === 0 ? 0 : 1;
}

async function claimRefusal(
  input: WorkspaceStart,
  members: readonly Member[],
): Promise<string | undefined> {
  const path = workspaceRecordPath(input.environment);
  if (path === undefined) return `${runtimeUnknown}\n`;
  const claim = await claimWorkspaceRecord(path, {
    processId: input.processId,
    members,
  });
  return claim.kind === "claimed"
    ? undefined
    : `workspace-already-running: The workspace supervisor with process ID ${String(claim.processId)} runs. Stop it first.\n`;
}

export async function workspaceStart(input: WorkspaceStart): Promise<number> {
  const file = workspaceFile(input.environment, input.home);
  const found = await workspaceMembers(input, file);
  if (found.kind === "refused") {
    input.refuse(found.text);
    return 1;
  }
  const refused = await claimRefusal(input, found.members);
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
  try {
    return await supervised(input, { path, members: found.members });
  } finally {
    await removeWorkspaceRecord(path, input.processId);
  }
}
