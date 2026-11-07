import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface HostProcesses {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly project: string;
  readonly product: string;
  readonly runtime: string;
  readonly directory: string;
  readonly repository: string;
  readonly checkout?: string;
  readonly watchPort: string;
  readonly phoneRelay: string;
  readonly updateMilliseconds: number | undefined;
  readonly restartMilliseconds?: number;
  readonly stopMilliseconds?: number;
  readonly watchRestart?: WatchRestartPolicy;
}

export interface WatchRestartPolicy {
  readonly delayMilliseconds: number;
  readonly fastMilliseconds: number;
  readonly limit: number;
  readonly windowMilliseconds: number;
}

const watchRestartPolicy: WatchRestartPolicy = {
  delayMilliseconds: 1000,
  fastMilliseconds: 60_000,
  limit: 5,
  windowMilliseconds: 600_000,
};

export interface Program {
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
    readonly stdio?: StdioOptions;
  },
): Program {
  const child = spawn(process.execPath, argumentsList, {
    cwd: settings.directory,
    env: settings.environment,
    stdio: settings.stdio ?? "inherit",
  });
  const ended = new Promise<number>((settle, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      settle(status ?? 1);
    });
  });
  return { name: settings.name, child, ended };
}

export async function stopped(
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
        ...(settings.environment ?? process.env),
        CLOVING_RUNTIME_DIR: settings.runtime,
        CLOVING_WATCH_REPOSITORY: settings.repository,
      },
    },
  );
}

export interface Hosted {
  readonly daemon: Program;
  readonly programs: Program[];
}

export function hostedChildren(settings: HostProcesses): Hosted {
  const daemon = launched([join(settings.project, "start.mjs")], {
    name: "daemon",
    directory: settings.project,
    environment: settings.environment ?? process.env,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const relay =
    settings.phoneRelay === "off" ? [] : [productChild(settings, ["relay"])];
  return { daemon, programs: [daemon, ...relay] };
}

function daemonStart(daemon: Program): Promise<"started" | "ended"> {
  return new Promise((settle) => {
    daemon.child.once("message", () => {
      settle("started");
    });
    daemon.ended.then(
      () => {
        settle("ended");
      },
      () => {
        settle("ended");
      },
    );
  });
}

interface WatchRestarts {
  readonly policy: WatchRestartPolicy;
  readonly restartedAt: number[];
  fastExits: number;
}

function restartDelay(
  restarts: WatchRestarts,
  exit: { readonly code: number; readonly lifetime: number },
): number | undefined {
  const { policy, restartedAt } = restarts;
  const now = performance.now();
  const recent = restartedAt.filter(
    (time) => now - time < policy.windowMilliseconds,
  );
  restartedAt.splice(0, restartedAt.length, ...recent);
  if (recent.length >= policy.limit) {
    process.stderr.write(
      `watch-restart-stopped code=${String(exit.code)} reason=restart-limit restarts=${String(policy.limit)} window=${String(policy.windowMilliseconds)}ms\n`,
    );
    return undefined;
  }
  restarts.fastExits =
    exit.lifetime < policy.fastMilliseconds ? restarts.fastExits + 1 : 0;
  return policy.delayMilliseconds * 2 ** Math.max(restarts.fastExits - 1, 0);
}

type WatchHosting = Hosted & {
  readonly stopped: () => boolean;
  readonly stopping: AbortSignal;
  readonly held: () => Promise<boolean> | undefined;
};

async function watchRuns(
  settings: HostProcesses,
  hosting: WatchHosting,
): Promise<void> {
  const restarts: WatchRestarts = {
    policy: settings.watchRestart ?? watchRestartPolicy,
    restartedAt: [],
    fastExits: 0,
  };
  for (;;) {
    if (hosting.stopped()) return;
    const startedAt = performance.now();
    const watch = productChild(settings, [
      "cli",
      "watch",
      "--port",
      settings.watchPort,
    ]);
    hosting.programs.splice(1, 0, watch);
    const code = await watch.ended;
    hosting.programs.splice(hosting.programs.indexOf(watch), 1);
    if (hosting.stopped()) return;
    const held = hosting.held();
    if (held !== undefined) {
      if (await held) continue;
      return;
    }
    const wait = restartDelay(restarts, {
      code,
      lifetime: performance.now() - startedAt,
    });
    if (wait === undefined) return;
    if (!(await waited(wait, hosting.stopping))) return;
    restarts.restartedAt.push(performance.now());
    process.stderr.write(
      `watch-restart code=${String(code)} delay=${String(wait)}ms\n`,
    );
  }
}

async function waited(
  milliseconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  return delay(milliseconds, true, { signal }).catch(() => false);
}

export async function watchAfterStart(
  settings: HostProcesses,
  hosting: WatchHosting,
): Promise<void> {
  if (settings.watchPort === "off") return;
  const start = await daemonStart(hosting.daemon);
  if (start === "ended") return;
  await watchRuns(settings, hosting);
}

function running(program: Program): boolean {
  return program.child.exitCode === null && program.child.signalCode === null;
}

async function stillRunning(
  children: readonly Program[],
  milliseconds: number,
): Promise<readonly Program[]> {
  for (const program of children)
    if (running(program)) program.child.kill("SIGTERM");
  const limit = new AbortController();
  await Promise.race([
    Promise.all(children.map((program) => program.ended.catch(() => 1))),
    delay(milliseconds, undefined, { signal: limit.signal }).catch(
      () => undefined,
    ),
  ]);
  limit.abort();
  return children.filter(running);
}

export interface ChildrenStop {
  readonly stop: () => Promise<readonly string[]>;
  readonly held: () => Promise<boolean> | undefined;
  readonly end: () => void;
}

export function childrenStop(
  settings: HostProcesses,
  hosted: Hosted,
): ChildrenStop {
  let hold: PromiseWithResolvers<boolean> | undefined;
  const relaunched = (): void => {
    for (const [index, program] of hosted.programs.entries())
      if (program.name === "relay" && !running(program))
        hosted.programs[index] = productChild(settings, ["relay"]);
  };
  return {
    stop: async () => {
      const pause = Promise.withResolvers<boolean>();
      hold = pause;
      const alive = await stillRunning(
        hosted.programs.filter((program) => program !== hosted.daemon),
        settings.stopMilliseconds ?? 60000,
      );
      if (alive.length === 0) return [];
      relaunched();
      hold = undefined;
      pause.resolve(true);
      return alive.map(
        (program) => `${String(program.child.pid)} ${program.name}`,
      );
    },
    held: () => hold?.promise,
    end: () => {
      hold?.resolve(false);
    },
  };
}
