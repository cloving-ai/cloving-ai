import { execFile } from "node:child_process";
import { addAbortListener } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { selfUpdater } from "./self-update.ts";
import { selfUpdateActive } from "./self-update-host.ts";
import {
  checkoutLock,
  clearedRestart,
  restartWatch,
  type RestartWatch,
} from "./self-host-restart.ts";
import {
  childrenStop,
  hostedChildren,
  stopped,
  watchAfterStart,
  type HostProcesses,
} from "./self-host-children.ts";

export type {
  HostProcesses,
  WatchRestartPolicy,
} from "./self-host-children.ts";

function updatingGit(settings: HostProcesses, stopping: AbortSignal) {
  const git = promisify(execFile);
  return async (argumentsList: readonly string[]): Promise<string> => {
    if (argumentsList[0] === "merge")
      return (
        await git("git", ["-C", settings.repository, ...argumentsList], {
          encoding: "utf8",
        })
      ).stdout;
    const command = git("git", ["-C", settings.repository, ...argumentsList], {
      encoding: "utf8",
      signal: stopping,
      killSignal: "SIGKILL",
      timeout:
        argumentsList[0] === "fetch" || argumentsList[0] === "remote"
          ? 30000
          : 0,
    });
    const listener = addAbortListener(stopping, () => {
      command.child.kill("SIGKILL");
    });
    try {
      return (await command).stdout;
    } finally {
      listener[Symbol.dispose]();
    }
  };
}

async function polled(
  settings: HostProcesses,
  lifecycle: Pick<RestartWatch, "stopping" | "stop" | "exclusive">,
): Promise<number | undefined> {
  if (settings.updateMilliseconds === undefined) {
    await rm(join(settings.directory, "pending-self-update"), { force: true });
    return;
  }
  const cancelled = (): boolean => lifecycle.stopping.aborted;
  const updater = selfUpdater({
    directory: settings.directory,
    git: updatingGit(settings, lifecycle.stopping),
    active: async () =>
      lifecycle.stopping.aborted ||
      (await selfUpdateActive({
        directory: settings.directory,
        runtimeDirectory: settings.runtime,
        signal: lifecycle.stopping,
      })),
    stop: async () => {
      if (lifecycle.stopping.aborted) throw new Error("self-update-stopped");
      await lifecycle.stop();
    },
    error: (line) => {
      process.stderr.write(line);
    },
  });
  while (!cancelled()) {
    await delay(settings.updateMilliseconds, undefined, {
      signal: lifecycle.stopping,
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    });
    if (cancelled()) return;
    const status = await lifecycle.exclusive(() => updater.check());
    if (status !== undefined) return status;
  }
  return undefined;
}

async function hostWatches(
  settings: HostProcesses,
  lifecycle: {
    readonly stopping: AbortController;
    readonly stop: () => Promise<void>;
    readonly stopChildren: () => Promise<readonly string[]>;
  },
): Promise<number | undefined> {
  const watches = {
    stopping: lifecycle.stopping.signal,
    stop: lifecycle.stop,
    exclusive: checkoutLock(lifecycle.stopping),
  };
  const [updated, restarted] = await Promise.all([
    polled(settings, watches),
    restartWatch({
      ...watches,
      stopChildren: lifecycle.stopChildren,
      directory: settings.directory,
      runtime: settings.runtime,
      checkout: settings.checkout ?? settings.product,
      environment: settings.environment ?? process.env,
      milliseconds: settings.restartMilliseconds ?? 2000,
    }),
  ]);
  return restarted ?? updated;
}

export async function hostedPrograms(settings: HostProcesses): Promise<number> {
  await clearedRestart(settings.directory);
  const { daemon, programs } = hostedChildren(settings);
  const stopping = new AbortController();
  let updating = false;
  let shutdown: Promise<void> | undefined;
  const pause = childrenStop(settings, { daemon, programs });
  const watching = watchAfterStart(settings, {
    daemon,
    programs,
    stopping: stopping.signal,
    stopped: () => shutdown !== undefined || stopping.signal.aborted,
    held: pause.held,
  });
  const stop = (): Promise<void> =>
    (shutdown ??= stopped(programs, settings.stopMilliseconds ?? 60000));
  const signal = (signal: NodeJS.Signals): void => {
    stopping.abort();
    for (const program of programs) program.child.kill(signal);
    shutdown = stop();
  };
  const interrupt = (): void => {
    signal("SIGINT");
  };
  const terminate = (): void => {
    signal("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const polling = hostWatches(settings, {
    stopping,
    stopChildren: pause.stop,
    stop: async () => {
      updating = true;
      await stop();
    },
  });
  try {
    const [status, updateStatus] = await Promise.all([
      daemon.ended.then((status) => {
        if (!updating) stopping.abort();
        return status;
      }),
      polling,
    ]);
    return updateStatus ?? status;
  } finally {
    stopping.abort();
    await stop();
    pause.end();
    await watching;
    await polling;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
