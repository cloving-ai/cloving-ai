import { setTimeout as delay } from "node:timers/promises";
import type { Fields, ServiceError } from "../protocol.ts";
import { send } from "./client.ts";
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
  | { readonly kind: "cancelled" }
  | { readonly kind: "interrupted" };

const cancelledRestart: ServiceError = {
  code: "restart-cancelled",
  detail: "Another command cancelled the restart before it started.",
};

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
  startedAt: unknown,
): Waited | undefined {
  if (now === undefined) return undefined;
  if (now["serviceStartedAt"] !== startedAt)
    return { kind: "restarted", after: now };
  return now["restart"] === null ? { kind: "cancelled" } : undefined;
}

async function restarted(
  environment: RestartEnvironment,
  startedAt: unknown,
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
    const outcome = settled(now, startedAt);
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
  const waited = await restarted(environment, before["serviceStartedAt"]);
  if (waited.kind === "interrupted") {
    environment.terminal.error(
      "The restart stays pending. Cancel it with: cloving restart --cancel\n",
    );
    return 130;
  }
  if (waited.kind === "cancelled")
    return failed(environment, { error: cancelledRestart, format });
  report(environment, { before, after: waited.after, json: invocation.json });
  return 0;
}
