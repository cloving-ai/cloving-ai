import { writeSync } from "node:fs";

export const workerHookTraceStart =
  process.env["CLOVING_WORKER_HOOK_TRACE_START"] ??
  process.hrtime.bigint().toString();

export function traceWorkerHook(phase: string): void {
  if (process.env["CLOVING_WORKER_HOOK_TRACE"] !== "1") return;
  const milliseconds =
    (process.hrtime.bigint() - BigInt(workerHookTraceStart)) / 1000000n;
  writeSync(
    process.env["CLOVING_WORKER_HOOK_TRACE_FD"] === "3" ? 3 : 2,
    `[cloving-worker-hook] ${String(milliseconds)}ms ${phase}\n`,
  );
}
