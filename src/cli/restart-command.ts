import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { record, type Fields, type ServiceError } from "../protocol.ts";
import { claimHost, restartFiles } from "../restart-request.ts";
import { send } from "./client.ts";
import { show } from "./terminal-text.ts";
import type { RestartInvocation } from "./restart-arguments.ts";
import {
  refusedWorkflowLines,
  restartedJson,
  restartedLines,
} from "./restart-render.ts";
import {
  failed,
  identified,
  presented,
  type OutputEnvironment,
} from "./command-output.ts";

export interface RestartEnvironment extends OutputEnvironment {
  readonly runtimeDirectory: string;
  readonly interrupted: () => Promise<void>;
  readonly answerMilliseconds?: number;
}

type Waited =
  | { readonly kind: "restarted"; readonly after: Fields }
  | { readonly kind: "failed"; readonly failure: Fields }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unanswered" }
  | { readonly kind: "interrupted" };

interface Waiting {
  readonly startedAt: string;
  readonly commandId: string;
  readonly requestedAt: number;
}

const cancelledRestart: ServiceError = {
  code: "restart-cancelled",
  detail: "Another command cancelled the restart before it started.",
};

const invalidReply: ServiceError = {
  code: "restart-reply-invalid",
  detail:
    "The service accepted the restart but sent no start time or no request time.",
};

function unansweredStart(milliseconds: number): ServiceError {
  return {
    code: "restart-start-unanswered",
    detail: `The service gave no status answer in ${String(milliseconds / 1000)} seconds after the start. Look at the terminal of cloving start.`,
  };
}

function waitingFor(reply: Fields, commandId: string): Waiting | undefined {
  const startedAt = reply["serviceStartedAt"];
  const requestedAt = record(reply["restart"])?.["requestedAt"];
  if (typeof startedAt !== "string") return undefined;
  if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt))
    return undefined;
  return { startedAt, commandId, requestedAt };
}

async function serviceStatus(
  runtimeDirectory: string,
  signal: AbortSignal,
): Promise<Fields | undefined> {
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { limit: 1 },
    signal,
  });
  return reply.kind === "result" ? reply.result : undefined;
}

function ownFailure(now: Fields, waiting: Waiting): Fields | undefined {
  const failure = record(now["restartFailure"]) ?? {};
  return failure["commandId"] === waiting.commandId &&
    failure["requestedAt"] === waiting.requestedAt
    ? failure
    : undefined;
}

function settled(now: Fields, waiting: Waiting): Waited | undefined {
  if (now["serviceStartedAt"] !== waiting.startedAt)
    return { kind: "restarted", after: now };
  const failure = ownFailure(now, waiting);
  if (failure !== undefined) return { kind: "failed", failure };
  return now["restart"] === null ? { kind: "cancelled" } : undefined;
}

const refusalDetails: Readonly<Record<string, string>> = {
  "restart-build-failed": "The build failed.",
  "restart-children-alive":
    "These child processes still ran after the stop limit.",
};

function refusal(failure: Fields, before: Fields): ServiceError {
  const { code, step, output } = failure;
  const commit = show(before["serviceCommit"] ?? "unknown");
  const reason =
    refusalDetails[String(code)] ?? `The update stopped at step ${show(step)}.`;
  const detail =
    code === "restart-deadline"
      ? "No gap came before the deadline. The restart is cancelled and the queue hold ended."
      : `${reason} The service keeps running on commit ${commit}.`;
  return {
    code: show(code),
    detail: `${detail}\n${show(output)}`,
    step,
    output,
  };
}

interface Unanswered {
  since: number | undefined;
}

function hostRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function claimHeld(runtimeDirectory: string): Promise<boolean> {
  const claim = join(dirname(runtimeDirectory), restartFiles.claimed);
  const host = claimHost(await readFile(claim, "utf8").catch(() => ""));
  return host !== undefined && hostRunning(host);
}

async function startLimitPassed(
  environment: RestartEnvironment,
  unanswered: Unanswered,
): Promise<boolean> {
  if (await claimHeld(environment.runtimeDirectory)) {
    unanswered.since = undefined;
    return false;
  }
  unanswered.since ??= Date.now();
  return (
    Date.now() - unanswered.since >= (environment.answerMilliseconds ?? 180_000)
  );
}

async function polled(
  environment: RestartEnvironment,
  watched: {
    readonly waiting: Waiting;
    readonly stopped: AbortSignal;
    readonly unanswered: Unanswered;
  },
): Promise<Waited | undefined> {
  const limit = environment.answerMilliseconds ?? 180_000;
  const now = await serviceStatus(
    environment.runtimeDirectory,
    AbortSignal.any([watched.stopped, AbortSignal.timeout(limit)]),
  );
  if (watched.stopped.aborted) return { kind: "interrupted" };
  if (now !== undefined) {
    watched.unanswered.since = undefined;
    return settled(now, watched.waiting);
  }
  return (await startLimitPassed(environment, watched.unanswered))
    ? { kind: "unanswered" }
    : undefined;
}

async function restarted(
  environment: RestartEnvironment,
  waiting: Waiting,
): Promise<Waited> {
  const stopped = new AbortController();
  const stop = (): void => {
    stopped.abort();
  };
  environment.interrupted().then(stop, stop);
  const unanswered: Unanswered = { since: undefined };
  for (;;) {
    const waited = await delay(250, true, { signal: stopped.signal }).catch(
      () => false,
    );
    if (!waited) return { kind: "interrupted" };
    const outcome = await polled(environment, {
      waiting,
      stopped: stopped.signal,
      unanswered,
    });
    if (outcome !== undefined) return outcome;
  }
}

function startErrors(daemons: {
  readonly before: Fields;
  readonly after: Fields;
  readonly update: Fields | undefined;
}): readonly ServiceError[] {
  const { before, after, update } = daemons;
  const refused = refusedWorkflowLines(before, after);
  return [
    ...(update?.["code"] === "restart-update-failed"
      ? [
          {
            code: "restart-update-failed",
            detail: `The update stopped at step ${show(update["step"])}. The checkout went back, and the service restarted on commit ${show(after["serviceCommit"] ?? "unknown")}.\n${show(update["output"])}`,
            step: update["step"],
            output: update["output"],
          },
        ]
      : []),
    ...(refused.length > 0
      ? [
          {
            code: "restart-workflow-refused",
            detail: [
              "The service restarted, but it refused these workflows:",
              ...refused,
            ].join("\n"),
          },
        ]
      : []),
  ];
}

function reported(
  environment: RestartEnvironment,
  daemons: {
    readonly before: Fields;
    readonly after: Fields;
    readonly waiting: Waiting;
    readonly format: ReturnType<typeof identified>;
  },
): number {
  const { before, after, format } = daemons;
  const update = ownFailure(after, daemons.waiting);
  const shown = { before, after, update };
  environment.terminal.out(
    format.json
      ? `${JSON.stringify(restartedJson(shown))}\n`
      : restartedLines(shown)
          .map((line) => `${line}\n`)
          .join(""),
  );
  const errors = startErrors(shown);
  for (const error of errors) failed(environment, { error, format });
  return errors.length > 0 ? 1 : 0;
}

function requested(invocation: RestartInvocation, commandId: string): Fields {
  if (invocation.cancel) return { cancel: true, commandId };
  return {
    at: invocation.at,
    commandId,
    ...(invocation.resumeQueue ? { resumeQueue: true } : {}),
    ...(invocation.settings === "files" ? { settings: "files" } : {}),
    ...(invocation.update ? { update: true } : {}),
    ...(invocation.within === null ? {} : { within: invocation.within }),
  };
}

function waitError(
  environment: RestartEnvironment,
  outcome: {
    readonly waited: Exclude<
      Waited,
      { readonly kind: "restarted" | "interrupted" }
    >;
    readonly before: Fields;
  },
): ServiceError {
  const { waited, before } = outcome;
  if (waited.kind === "cancelled") return cancelledRestart;
  if (waited.kind === "unanswered")
    return unansweredStart(environment.answerMilliseconds ?? 180_000);
  return refusal(waited.failure, before);
}

export async function restartCommand(
  environment: RestartEnvironment,
  invocation: RestartInvocation,
): Promise<number> {
  const format = identified(environment, invocation);
  const reply = await send(environment.runtimeDirectory, {
    operation: "restart",
    parameters: requested(invocation, format.commandId),
  });
  const shown = presented(environment, { reply, format });
  if (reply.kind === "error" || invocation.cancel) return shown;
  const before = reply.result;
  const waiting = waitingFor(before, format.commandId);
  if (waiting === undefined)
    return failed(environment, { error: invalidReply, format });
  const waited = await restarted(environment, waiting);
  if (waited.kind === "interrupted") {
    environment.terminal.error(
      "The restart stays pending. Cancel it with: cloving restart --cancel\n",
    );
    return 130;
  }
  if (waited.kind !== "restarted")
    return failed(environment, {
      error: waitError(environment, { waited, before }),
      format,
    });
  return reported(environment, {
    before,
    after: waited.after,
    waiting,
    format,
  });
}
