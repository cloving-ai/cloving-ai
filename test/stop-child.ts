import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";

export async function stopChild(
  child: ChildProcess,
  options: { readonly graceMilliseconds?: number } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const grace =
    options.graceMilliseconds ??
    5000 * parseCheckTimeFactor(process.env["CLOVING_CHECK_TIME_FACTOR"]);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), grace);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function signalGroup(identifier: number, signal: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-identifier, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function groupGone(
  identifier: number,
  milliseconds: number,
): Promise<boolean> {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (!signalGroup(identifier, 0)) return true;
    await delay(Math.min(25, deadline - performance.now()));
  }
  return false;
}

export async function stopChildGroup(
  child: ChildProcess,
  options: { readonly graceMilliseconds?: number } = {},
): Promise<void> {
  if (child.pid === undefined || !signalGroup(child.pid, "SIGTERM")) return;
  const grace =
    options.graceMilliseconds ??
    5000 * parseCheckTimeFactor(process.env["CLOVING_CHECK_TIME_FACTOR"]);
  if (!(await groupGone(child.pid, grace))) {
    signalGroup(child.pid, "SIGKILL");
    if (!(await groupGone(child.pid, 1000)))
      throw new Error("test-child-process-group-remains");
  }
  if (child.exitCode === null && child.signalCode === null)
    await once(child, "exit");
}
