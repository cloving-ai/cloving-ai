import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { selfUpdater } from "./self-update.ts";
import { workerTurnActive } from "./self-update-host.ts";

export interface HostProcesses {
  readonly project: string;
  readonly product: string;
  readonly runtime: string;
  readonly directory: string;
  readonly repository: string;
  readonly watchPort: string;
  readonly updateMilliseconds: number | undefined;
}

interface Program {
  readonly child: ChildProcess;
  readonly ended: Promise<number>;
}

function launched(
  argumentsList: readonly string[],
  settings: {
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
  return { child, ended };
}

async function stopped(programs: readonly Program[]): Promise<void> {
  for (const program of programs) program.child.kill("SIGTERM");
  await Promise.all(programs.map((program) => program.ended));
}

async function polled(
  settings: HostProcesses,
  lifecycle: {
    readonly stopping: AbortSignal;
    readonly stop: () => Promise<void>;
  },
): Promise<number | undefined> {
  if (settings.updateMilliseconds === undefined) return;
  const cancelled = (): boolean => lifecycle.stopping.aborted;
  const git = promisify(execFile);
  const updater = selfUpdater({
    directory: settings.directory,
    git: async (argumentsList) => {
      const result = await git(
        "git",
        ["-C", settings.repository, ...argumentsList],
        { encoding: "utf8" },
      );
      return result.stdout;
    },
    active: async () =>
      lifecycle.stopping.aborted ||
      (await workerTurnActive(settings.directory)),
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
      if (Reflect.get(Object(error), "name") !== "AbortError") throw error;
    });
    if (cancelled()) return;
    const status = await updater.check();
    if (status !== undefined) return status;
  }
  return undefined;
}

function hostedChildren(settings: HostProcesses): readonly Program[] {
  const daemon = launched([join(settings.project, "start.mjs")], {
    directory: settings.project,
    environment: process.env,
  });
  const programs = [daemon];
  if (settings.watchPort !== "off")
    programs.push(
      launched(
        [
          join(settings.product, "src/cli.ts"),
          "watch",
          "--port",
          settings.watchPort,
        ],
        {
          directory: settings.product,
          environment: {
            ...process.env,
            CLOVING_RUNTIME_DIR: settings.runtime,
          },
        },
      ),
    );
  return programs;
}

export async function hostedPrograms(settings: HostProcesses): Promise<number> {
  const programs = hostedChildren(settings);
  const daemon = programs[0];
  if (!daemon) throw new Error("self-host-daemon-missing");
  const stopping = new AbortController();
  let updating = false;
  const interrupt = (): void => {
    stopping.abort();
    for (const program of programs) program.child.kill("SIGINT");
  };
  const terminate = (): void => {
    stopping.abort();
    for (const program of programs) program.child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const polling = polled(settings, {
    stopping: stopping.signal,
    stop: async () => {
      updating = true;
      await stopped(programs);
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
    await stopped(programs);
    await polling;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
