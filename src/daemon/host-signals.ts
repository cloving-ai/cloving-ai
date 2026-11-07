import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { promisify } from "node:util";
import {
  meminfoPressure,
  sysctlPressure,
  type HostSignals,
  type MemoryPressure,
} from "../queue-room.ts";

export interface SignalSources {
  readonly platform: string;
  readonly sysctl: () => Promise<string>;
  readonly meminfo: () => Promise<string>;
}

const run = promisify(execFile);

export const hostSources: SignalSources = {
  platform: process.platform,
  sysctl: async () =>
    (
      await run(
        "/usr/sbin/sysctl",
        ["-n", "kern.memorystatus_vm_pressure_level"],
        {
          timeout: 5000,
        },
      )
    ).stdout,
  meminfo: () => readFile("/proc/meminfo", "utf8"),
};

const unread = (): string => "";

async function pressure(sources: SignalSources): Promise<MemoryPressure> {
  if (sources.platform === "darwin")
    return sysctlPressure(await sources.sysctl().catch(unread));
  if (sources.platform === "linux")
    return meminfoPressure(await sources.meminfo().catch(unread));
  return "normal";
}

export function hostSignals(
  sources: SignalSources = hostSources,
): () => Promise<HostSignals> {
  return async () => ({
    loadAverage: loadavg()[0] ?? 0,
    cores: availableParallelism(),
    memoryPressure: await pressure(sources),
  });
}
