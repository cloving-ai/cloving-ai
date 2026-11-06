import { setTimeout as delay } from "node:timers/promises";
import { record, type Fields, type ServiceError } from "../protocol.ts";
import { send } from "./client.ts";
import { show } from "./terminal-text.ts";
import type { RestartInvocation } from "./restart-arguments.ts";
import { restartedJson, restartedLines } from "./restart-render.ts";
import {
  failed,
  identified,
  presented,
  type OutputEnvironment,
} from "./command-output.ts";

export interface RestartEnvironment extends OutputEnvironment {
  readonly runtimeDirectory: string;
  readonly interrupted: () => Promise<void>;
}

type Waited =
  | { readonly kind: "restarted"; readonly after: Fields }
  | { readonly kind: "failed"; readonly failure: Fields }
  | { readonly kind: "cancelled" }
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

function settled(
  now: Fields | undefined,
  waiting: Waiting,
): Waited | undefined {
  if (now === undefined) return undefined;
  if (now["serviceStartedAt"] !== waiting.startedAt)
    return { kind: "restarted", after: now };
  const failure = record(now["restartFailure"]) ?? {};
  if (
    failure["commandId"] === waiting.commandId &&
    failure["requestedAt"] === waiting.requestedAt
  )
    return { kind: "failed", failure };
  return now["restart"] === null ? { kind: "cancelled" } : undefined;
}

function updateFailure(failure: Fields, before: Fields): ServiceError {
  const { step, output } = failure;
  return {
    code: "restart-update-failed",
    detail: `The update stopped at step ${show(step)}. The service keeps running on commit ${show(before["serviceCommit"] ?? "unknown")}.\n${show(output)}`,
    step,
    output,
  };
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
  for (;;) {
    const waited = await delay(250, true, { signal: stopped.signal }).catch(
      () => false,
    );
    if (!waited) return { kind: "interrupted" };
    const now = await serviceStatus(
      environment.runtimeDirectory,
      stopped.signal,
    );
    if (stopped.signal.aborted) return { kind: "interrupted" };
    const outcome = settled(now, waiting);
    if (outcome !== undefined) return outcome;
  }
}

function report(
  environment: RestartEnvironment,
  daemons: {
    readonly before: Fields;
    readonly after: Fields;
    readonly json: boolean;
  },
): void {
  const { before, after } = daemons;
  environment.terminal.out(
    daemons.json
      ? `${JSON.stringify(restartedJson(before, after))}\n`
      : restartedLines(before, after)
          .map((line) => `${line}\n`)
          .join(""),
  );
}

function requested(invocation: RestartInvocation, commandId: string): Fields {
  if (invocation.cancel) return { cancel: true, commandId };
  return {
    at: invocation.at,
    commandId,
    ...(invocation.resumeQueue ? { resumeQueue: true } : {}),
    ...(invocation.settings === "files" ? { settings: "files" } : {}),
    ...(invocation.update ? { update: true } : {}),
  };
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
  if (waited.kind === "cancelled")
    return failed(environment, { error: cancelledRestart, format });
  if (waited.kind === "failed")
    return failed(environment, {
      error: updateFailure(waited.failure, before),
      format,
    });
  report(environment, { before, after: waited.after, json: invocation.json });
  return 0;
}
