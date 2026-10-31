import { execFile, spawn, type ChildProcess } from "node:child_process";
import { addAbortListener } from "node:events";
import { rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { selfUpdater } from "./self-update.ts";
import { selfUpdateActive } from "./self-update-host.ts";

export interface HostProcesses {
  readonly project: string;
  readonly product: string;
  readonly runtime: string;
  readonly directory: string;
  readonly repository: string;
  readonly watchPort: string;
  readonly phoneRelay: string;
  readonly updateMilliseconds: number | undefined;
  readonly stopMilliseconds?: number;
}

interface Program {
  readonly name: string;
  readonly child: ChildProcess;
  readonly ended: Promise<number>;
}

function launched(
  argumentsList: readonly string[],
  settings: {
    readonly name: string;
    readonly directory: string;
    readonly environment: NodeJS.ProcessEnv;
  },
): Program {
  const child = spawn(process.execPath, argumentsList, {
    cwd: settings.directory,
    env: settings.environment,
    stdio: "inherit",
  });
  const ended = new Promise<number>((settle, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      settle(status ?? 1);
    });
  });
  return { name: settings.name, child, ended };
}

async function stopped(
  programs: readonly Program[],
  milliseconds: number,
): Promise<void> {
  for (const program of programs)
    if (
      !program.child.killed &&
      program.child.exitCode === null &&
      program.child.signalCode === null
    )
      program.child.kill("SIGTERM");
  await Promise.all(
    programs.map(async (program) => {
      const timer = setTimeout(() => {
        if (program.child.kill("SIGKILL"))
          process.stderr.write(
            `Cloving stopped the ${program.name} child with SIGKILL after ${String(milliseconds / 1000)} s\n`,
          );
      }, milliseconds);
      try {
        await program.ended;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

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
  lifecycle: {
    readonly stopping: AbortSignal;
    readonly stop: () => Promise<void>;
  },
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
    const status = await updater.check();
    if (status !== undefined) return status;
  }
  return undefined;
}

function productChild(
  settings: HostProcesses,
  argumentsList: readonly [string, ...string[]],
): Program {
  const [program, ...rest] = argumentsList;
  return launched(
    [
      join(settings.product, `src/${program}${extname(import.meta.filename)}`),
      ...rest,
    ],
    {
      name: program === "cli" ? "watch" : program,
      directory: settings.product,
      environment: {
        ...process.env,
        CLOVING_RUNTIME_DIR: settings.runtime,
        CLOVING_WATCH_REPOSITORY: settings.repository,
      },
    },
  );
}

interface Hosted {
  readonly daemon: Program;
  readonly programs: readonly Program[];
}

function hostedChildren(settings: HostProcesses): Hosted {
  const daemon = launched([join(settings.project, "start.mjs")], {
    name: "daemon",
    directory: settings.project,
    environment: process.env,
  });
  const watch =
    settings.watchPort === "off"
      ? []
      : [
          productChild(settings, [
            "cli",
            "watch",
            "--port",
            settings.watchPort,
          ]),
        ];
  const relay =
    settings.phoneRelay === "off" ? [] : [productChild(settings, ["relay"])];
  return { daemon, programs: [daemon, ...watch, ...relay] };
}

export async function hostedPrograms(settings: HostProcesses): Promise<number> {
  const { daemon, programs } = hostedChildren(settings);
  const stopping = new AbortController();
  let updating = false;
  let shutdown: Promise<void> | undefined;
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
  const polling = polled(settings, {
    stopping: stopping.signal,
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
    await polling;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
