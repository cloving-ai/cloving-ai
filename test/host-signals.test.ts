import assert from "node:assert/strict";
import { test } from "node:test";
import { availableParallelism } from "node:os";
import { hostSignals, hostSources } from "../src/daemon/host-signals.ts";
import { meminfoPressure, sysctlPressure } from "../src/queue-room.ts";

const meminfo = (total: number, available: number): string =>
  `MemTotal:       ${String(total)} kB\nMemFree:          1000 kB\nMemAvailable:   ${String(available)} kB\n`;

await test("CLV-309 the macOS pressure levels map to normal, warn and critical", () => {
  assert.equal(sysctlPressure("1\n"), "normal");
  assert.equal(sysctlPressure("2\n"), "warn");
  assert.equal(sysctlPressure("4\n"), "critical");
  for (const output of ["", "3", "high", "12"])
    assert.equal(sysctlPressure(output), "unknown");
});

await test("CLV-309 the Linux pressure comes from MemAvailable of the kernel memory file", () => {
  assert.equal(meminfoPressure(meminfo(1000, 200)), "normal");
  assert.equal(meminfoPressure(meminfo(1000, 199)), "warn");
  assert.equal(meminfoPressure(meminfo(1000, 100)), "warn");
  assert.equal(meminfoPressure(meminfo(1000, 99)), "critical");
  assert.equal(meminfoPressure("MemTotal: 1000 kB\n"), "unknown");
  assert.equal(meminfoPressure(meminfo(0, 0)), "unknown");
});

await test("CLV-309 the host reader reads the pressure of the platform", async () => {
  const failing = () => Promise.reject(new Error("unreadable"));
  const read = (platform: string, output: string) =>
    hostSignals({
      platform,
      sysctl: () => Promise.resolve(output),
      meminfo: () => Promise.resolve(meminfo(1000, 150)),
    })();
  assert.equal((await read("darwin", "2")).memoryPressure, "warn");
  assert.equal((await read("linux", "1")).memoryPressure, "warn");
  assert.equal((await read("win32", "4")).memoryPressure, "normal");
  const unreadable = hostSignals({
    platform: "darwin",
    sysctl: failing,
    meminfo: failing,
  });
  assert.equal((await unreadable()).memoryPressure, "unknown");
  const linux = hostSignals({
    platform: "linux",
    sysctl: failing,
    meminfo: failing,
  });
  assert.equal((await linux()).memoryPressure, "unknown");
});

await test("CLV-309 the host reader gives the load average, the cores and a known pressure", async () => {
  const signals = await hostSignals()();
  assert.ok(signals.loadAverage >= 0);
  assert.equal(signals.cores, availableParallelism());
  assert.ok(
    ["normal", "warn", "critical", "unknown"].includes(signals.memoryPressure),
  );
  const sources = await Promise.allSettled([
    hostSources.sysctl(),
    hostSources.meminfo(),
  ]);
  assert.equal(
    sources.some((source) => source.status === "fulfilled"),
    ["darwin", "linux"].includes(process.platform),
  );
});
