import type { ChildProcess } from "node:child_process";
import { selfUpdater, type SelfUpdate } from "./self-update.ts";

export interface HostProcesses {
  readonly daemon: ChildProcess;
  readonly watch: ChildProcess | undefined;
  readonly update?: {
    readonly milliseconds: number;
    readonly settings: Omit<SelfUpdate, "stop">;
  };
}

function finished(child: ChildProcess): Promise<number> {
  return new Promise((settle) => {
    child.once("error", () => {
      settle(1);
    });
    child.once("close", (status) => {
      settle(status ?? 1);
    });
  });
}

function polling(
  settings: HostProcesses["update"],
  lifecycle: {
    readonly stop: () => Promise<void>;
    readonly signal: AbortSignal;
  },
) {
  let checking = Promise.resolve<number | undefined>(undefined);
  let pending = false;
  if (settings === undefined) return { close: () => checking };
  const check = selfUpdater({ ...settings.settings, ...lifecycle });
  const timer = setInterval(() => {
    if (pending || lifecycle.signal.aborted) return;
    pending = true;
    checking = check()
      .catch((error: unknown) => {
        const cause = error instanceof Error ? error.message : String(error);
        settings.settings.report(
          `self-update-check-failed: ${cause.replace(/\s+/g, " ")}`,
        );
        return undefined;
      })
      .finally(() => {
        pending = false;
      });
  }, settings.milliseconds);
  return {
    close: () => {
      clearInterval(timer);
      return checking;
    },
  };
}

export async function hostProcesses(settings: HostProcesses): Promise<number> {
  const abort = new AbortController();
  const children = [settings.daemon, settings.watch].filter(
    (child) => child !== undefined,
  );
  const exits = children.map(finished);
  const stop = async (): Promise<void> => {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(exits);
  };
  const interrupt = (): void => {
    abort.abort();
    for (const child of children) child.kill("SIGINT");
  };
  const terminate = (): void => {
    abort.abort();
    for (const child of children) child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const updateState = { stopping: false };
  const updates = polling(settings.update, {
    stop: async () => {
      updateState.stopping = true;
      await stop();
    },
    signal: abort.signal,
  });
  try {
    const status = await exits[0];
    if (!updateState.stopping) abort.abort();
    const updateStatus = await updates.close();
    if (abort.signal.aborted) return status ?? 1;
    return updateStatus ?? status ?? 1;
  } finally {
    await stop();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
