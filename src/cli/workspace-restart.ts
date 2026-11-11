import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Fields, Reply } from "../protocol.ts";
import { isRestartTime, type RestartTime } from "../restart-request.ts";
import type { WorkspaceHold } from "../queue-room.ts";
import { atGap, workInProgress } from "../work-gap.ts";
import { send } from "./client.ts";
import {
  polled,
  waitingFor,
  type Unanswered,
  type Waited,
  type Waiting,
} from "./restart-command.ts";
import { refusedWorkflowLines } from "./restart-render.ts";
import { show } from "./terminal-text.ts";
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
  readonly permits: () => number;
  readonly gapMilliseconds: number;
  readonly answerMilliseconds: number;
  readonly signal: AbortSignal;
}

type MemberOutcome = Exclude<Waited, { readonly kind: "interrupted" }>;

interface FailedEntry {
  readonly name: string;
  readonly error: string;
  readonly refusedWorkflows?: readonly string[];
}

interface RestartedEntry {
  readonly name: string;
  readonly serviceStartedAt: unknown;
}

type MemberEntry = FailedEntry | RestartedEntry;

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
    const idle = restarting.permits() === 0;
    const gaps = await Promise.all(members.map(memberAtGap));
    if (idle && !gaps.includes(false)) return;
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
): Promise<MemberOutcome> {
  const { waiting, restarting } = input;
  const source = {
    runtimeDirectory: member.runtime,
    answerMilliseconds: restarting.answerMilliseconds,
  };
  const unanswered: Unanswered = { since: undefined };
  for (;;) {
    const outcome = await polled(source, {
      waiting,
      stopped: restarting.signal,
      unanswered,
    });
    if (outcome !== undefined && outcome.kind !== "interrupted") return outcome;
    await delay(restarting.gapMilliseconds, undefined, {
      signal: restarting.signal,
    });
  }
}

function settledEntry(
  name: string,
  outcome: MemberOutcome & { readonly before: Fields },
): MemberEntry {
  if (outcome.kind === "cancelled") return { name, error: "restart-cancelled" };
  if (outcome.kind === "unanswered")
    return { name, error: "restart-start-unanswered" };
  if (outcome.kind === "failed")
    return { name, error: show(outcome.failure["code"]) };
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
): Promise<MemberEntry> {
  const { request, restarting } = input;
  const reply = await send(member.runtime, {
    operation: "restart",
    parameters: {
      commandId: request.commandId,
      at: request.at === "keep" ? "keep" : "now",
      ...request.options,
    },
    signal: AbortSignal.any([
      restarting.signal,
      AbortSignal.timeout(restarting.answerMilliseconds),
    ]),
  });
  if (reply.kind === "error")
    return { name: member.name, error: reply.error.code };
  const waiting = waitingFor(reply.result, request.commandId);
  if (waiting === undefined)
    return { name: member.name, error: "restart-reply-invalid" };
  const outcome = await settledMember(member, { waiting, restarting });
  return settledEntry(member.name, { ...outcome, before: reply.result });
}

function failedDetail(failed: readonly FailedEntry[]): string {
  const names = failed
    .map((entry) => `${entry.name} (${entry.error})`)
    .join(", ");
  const workflows = failed.flatMap((entry) =>
    (entry.refusedWorkflows ?? []).map((line) => `${entry.name}: ${line}`),
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
  const failed = repositories.filter(
    (entry): entry is FailedEntry => "error" in entry,
  );
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
