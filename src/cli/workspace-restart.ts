import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Fields, Reply } from "../protocol.ts";
import { isRestartTime, type RestartTime } from "../restart-request.ts";
import type { WorkspaceHold } from "../queue-room.ts";
import { atGap, workInProgress } from "../work-gap.ts";
import { send } from "./client.ts";
import {
  settled,
  waitingFor,
  type Settled,
  type Waiting,
} from "./restart-command.ts";
import { refusedWorkflowLines } from "./restart-render.ts";
import { argumentRules } from "./runtime-invocation.ts";
import { daemonWorkReads } from "./work-reads.ts";
import type { WorkspaceMember } from "./workspace-record.ts";

export interface WorkspaceRestart {
  readonly hold: () => WorkspaceHold | undefined;
  readonly requested: (parameters: Fields) => Promise<Reply>;
}

interface RestartRequest {
  readonly commandId: string;
  readonly at: RestartTime;
  readonly options: Fields;
}

interface Restarting {
  readonly members: () => readonly WorkspaceMember[];
  readonly gapMilliseconds: number;
  readonly signal: AbortSignal;
}

const restartHold: WorkspaceHold = {
  reason: "workspace-restart",
  text: "Held: the workspace restarts at the next common gap",
};

function failure(code: string, detail: string): Reply {
  return { kind: "error", error: { code, detail } };
}

function validOptions(parameters: Fields): boolean {
  const { resumeQueue, settings } = parameters;
  return (
    (resumeQueue === undefined || resumeQueue === true) &&
    (settings === undefined || settings === "files")
  );
}

function restartRequest(parameters: Fields): RestartRequest | undefined {
  const { commandId, at = "gap", resumeQueue, settings } = parameters;
  if (
    typeof commandId !== "string" ||
    !argumentRules.identifier.test(commandId)
  )
    return undefined;
  if (!isRestartTime(at) || !validOptions(parameters)) return undefined;
  return {
    commandId,
    at,
    options: {
      ...(resumeQueue === true ? { resumeQueue } : {}),
      ...(settings === "files" ? { settings } : {}),
    },
  };
}

async function memberStatus(
  member: WorkspaceMember,
): Promise<Fields | undefined> {
  const reply = await send(member.runtime, {
    operation: "status",
    parameters: { limit: 1 },
  });
  return reply.kind === "result" ? reply.result : undefined;
}

function memberAtGap(member: WorkspaceMember): Promise<boolean> {
  const reads = daemonWorkReads({
    directory: dirname(member.runtime),
    runtimeDirectory: member.runtime,
  });
  return workInProgress(reads).then(atGap, () => false);
}

async function commonGap(
  members: readonly WorkspaceMember[],
  restarting: Restarting,
): Promise<void> {
  for (;;) {
    const gaps = await Promise.all(members.map(memberAtGap));
    if (!gaps.includes(false)) return;
    await delay(restarting.gapMilliseconds, undefined, {
      signal: restarting.signal,
    });
  }
}

async function settledMember(
  member: WorkspaceMember,
  input: {
    readonly waiting: Waiting;
    readonly restarting: Restarting;
  },
): Promise<Settled> {
  for (;;) {
    const now = await memberStatus(member);
    const outcome = now === undefined ? undefined : settled(now, input.waiting);
    if (outcome !== undefined) return outcome;
    await delay(input.restarting.gapMilliseconds, undefined, {
      signal: input.restarting.signal,
    });
  }
}

function settledEntry(
  name: string,
  outcome: Settled & { readonly before: Fields },
): Fields {
  if (outcome.kind === "cancelled") return { name, error: "restart-cancelled" };
  if (outcome.kind === "failed")
    return { name, error: String(outcome.failure["code"]) };
  const refusedWorkflows = refusedWorkflowLines(outcome.before, outcome.after);
  if (refusedWorkflows.length > 0)
    return { name, error: "restart-workflow-refused", refusedWorkflows };
  return { name, serviceStartedAt: outcome.after["serviceStartedAt"] };
}

async function restartedMember(
  member: WorkspaceMember,
  input: {
    readonly request: RestartRequest;
    readonly restarting: Restarting;
  },
): Promise<Fields> {
  const { request, restarting } = input;
  const reply = await send(member.runtime, {
    operation: "restart",
    parameters: {
      commandId: request.commandId,
      at: "now",
      ...request.options,
    },
  });
  if (reply.kind === "error")
    return { name: member.name, error: reply.error.code };
  const waiting = waitingFor(reply.result, request.commandId);
  if (waiting === undefined)
    return { name: member.name, error: "restart-reply-invalid" };
  const outcome = await settledMember(member, { waiting, restarting });
  return settledEntry(member.name, { ...outcome, before: reply.result });
}

function failedDetail(failed: readonly Fields[]): string {
  const names = failed
    .map((entry) => `${String(entry["name"])} (${String(entry["error"])})`)
    .join(", ");
  const workflows = failed.flatMap((entry) =>
    Array.isArray(entry["refusedWorkflows"])
      ? entry["refusedWorkflows"].map(
          (line: unknown) => `${String(entry["name"])}: ${String(line)}`,
        )
      : [],
  );
  return [
    `The restart failed in these repositories: ${names}.`,
    ...workflows,
  ].join("\n");
}

async function restartedWorkspace(
  request: RestartRequest,
  restarting: Restarting,
): Promise<Reply> {
  const members = restarting.members();
  if (request.at === "gap") await commonGap(members, restarting);
  const repositories = await Promise.all(
    members.map((member) => restartedMember(member, { request, restarting })),
  );
  const failed = repositories.filter((entry) => entry["error"] !== undefined);
  if (failed.length > 0)
    return failure("workspace-restart-failed", failedDetail(failed));
  return {
    kind: "result",
    result: {
      kind: "workspace-restart",
      commandId: request.commandId,
      repositories,
    },
  };
}

export function workspaceRestart(restarting: Restarting): WorkspaceRestart {
  let pending:
    { readonly commandId: string; readonly reply: Promise<Reply> } | undefined;
  return {
    hold: () => (pending === undefined ? undefined : restartHold),
    requested: (parameters) => {
      const request = restartRequest(parameters);
      if (request === undefined)
        return Promise.resolve(
          failure(
            "invalid-request",
            "The workspace restart request is not valid.",
          ),
        );
      if (pending?.commandId === request.commandId) return pending.reply;
      if (pending !== undefined)
        return Promise.resolve(
          failure(
            "workspace-restart-pending",
            `The workspace restart ${pending.commandId} waits for a common gap.`,
          ),
        );
      const reply = restartedWorkspace(request, restarting)
        .catch(() =>
          failure(
            "workspace-restart-stopped",
            "The workspace supervisor stopped before the restart.",
          ),
        )
        .finally(() => {
          pending = undefined;
        });
      pending = { commandId: request.commandId, reply };
      return reply;
    },
  };
}
