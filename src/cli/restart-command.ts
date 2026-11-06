import { setTimeout as delay } from "node:timers/promises";
import type { Fields } from "../protocol.ts";
import { send } from "./client.ts";
import type { RestartInvocation } from "./restart-arguments.ts";
import { restartedJson, restartedLines } from "./restart-render.ts";
import {
  identified,
  presented,
  type OutputEnvironment,
} from "./command-output.ts";

export interface RestartEnvironment extends OutputEnvironment {
  readonly runtimeDirectory: string;
  readonly interrupted: () => Promise<void>;
}

async function serviceStatus(
  runtimeDirectory: string,
): Promise<Fields | undefined> {
  const reply = await send(runtimeDirectory, {
    operation: "status",
    parameters: { limit: 1 },
  });
  return reply.kind === "result" ? reply.result : undefined;
}

async function restarted(
  environment: RestartEnvironment,
  startedAt: unknown,
): Promise<Fields | undefined> {
  const stopped = new AbortController();
  const stop = (): void => {
    stopped.abort();
  };
  environment.interrupted().then(stop, stop);
  for (;;) {
    const waited = await delay(250, true, { signal: stopped.signal }).catch(
      () => false,
    );
    if (!waited) return undefined;
    const now = await serviceStatus(environment.runtimeDirectory);
    if (now !== undefined && now["serviceStartedAt"] !== startedAt) return now;
  }
}

function report(
  environment: RestartEnvironment,
  daemons: {
    readonly before: Fields | undefined;
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

export async function restartCommand(
  environment: RestartEnvironment,
  invocation: RestartInvocation,
): Promise<number> {
  const { runtimeDirectory } = environment;
  const format = identified(environment, invocation);
  const { commandId } = format;
  const asked = async (parameters: Fields) =>
    presented(environment, {
      reply: await send(runtimeDirectory, { operation: "restart", parameters }),
      format,
    });
  if (invocation.cancel) return asked({ cancel: true, commandId });
  const before = await serviceStatus(runtimeDirectory);
  const shown = await asked({
    at: invocation.at,
    commandId,
    ...(invocation.resumeQueue ? { resumeQueue: true } : {}),
  });
  if (shown !== 0) return shown;
  const after = await restarted(environment, before?.["serviceStartedAt"]);
  if (after === undefined) {
    environment.terminal.error(
      "The restart stays pending. Cancel it with: cloving restart --cancel\n",
    );
    return 130;
  }
  report(environment, { before, after, json: invocation.json });
  return 0;
}
