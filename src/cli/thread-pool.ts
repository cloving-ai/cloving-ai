import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  threadPoolStallExitCode,
  type StalledCheck,
  type ThreadPoolCheck,
} from "../thread-pool-check.ts";

export interface ThreadPoolSettings {
  readonly check?: () => Promise<unknown>;
  readonly intervalMilliseconds?: number;
  readonly deadlineMilliseconds?: number;
}

export interface ThreadPoolWatch {
  readonly latest: () => ThreadPoolCheck | undefined;
  readonly stop: () => void;
}

const installFile = fileURLToPath(import.meta.resolve("#package"));

function installStatus(): Promise<unknown> {
  return stat(installFile);
}

function resourceCounts(): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo())
    counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

export function threadPoolWatch(
  settings: ThreadPoolSettings & {
    readonly stalled: (check: StalledCheck) => void;
  },
): ThreadPoolWatch {
  const check = settings.check ?? installStatus;
  const deadline = settings.deadlineMilliseconds ?? 5000;
  const state: {
    latest?: ThreadPoolCheck;
    pending: boolean;
    timer?: NodeJS.Timeout;
  } = { pending: false };
  const elapsed = (started: number): number =>
    Math.round(performance.now() - started);
  const checked = (): void => {
    if (state.pending) return;
    state.pending = true;
    const started = performance.now();
    state.timer = setTimeout(() => {
      const stall: StalledCheck = {
        result: "stalled",
        checkedAt: new Date().toISOString(),
        milliseconds: elapsed(started),
        resources: resourceCounts(),
      };
      state.latest = stall;
      settings.stalled(stall);
    }, deadline).unref();
    const settled = (): void => {
      clearTimeout(state.timer);
      state.pending = false;
      state.latest = {
        result: "ok",
        checkedAt: new Date().toISOString(),
        milliseconds: elapsed(started),
      };
    };
    check().then(settled, settled);
  };
  const interval = setInterval(
    checked,
    settings.intervalMilliseconds ?? 60_000,
  ).unref();
  checked();
  return {
    latest: () => state.latest,
    stop: () => {
      clearInterval(interval);
      clearTimeout(state.timer);
    },
  };
}

export interface StallExitHost {
  readonly execPath: string;
  readonly stderr: {
    readonly write: (text: string, done: () => void) => boolean;
  };
  readonly execve?: (file: string, args?: readonly string[]) => never;
  readonly exit: (code: number) => never;
}

export async function stalledExit(host: StallExitHost): Promise<void> {
  await new Promise<void>((settle) => {
    host.stderr.write("", () => {
      settle();
    });
  });
  try {
    host.execve?.(host.execPath, [
      host.execPath,
      "--eval",
      `process.exitCode = ${String(threadPoolStallExitCode)}`,
    ]);
  } finally {
    host.exit(threadPoolStallExitCode);
  }
}
