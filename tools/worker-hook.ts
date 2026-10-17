import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readWorkerHookInput } from "../quality/worker-hook-stdin.ts";
import {
  traceWorkerHook,
  workerHookTraceStart,
} from "../quality/worker-hook-trace.ts";

traceWorkerHook("start");
try {
  const policy = process.argv[2];
  if (!policy) throw new Error("missing-worker-hook-policy");
  const input = await readWorkerHookInput(process.stdin);
  traceWorkerHook("input:read");
  traceWorkerHook("check:start");
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "worker-hook-check.ts"), policy],
    {
      input,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      stdio: ["pipe", "pipe", "pipe", 2],
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        NODE_DISABLE_COMPILE_CACHE: "1",
        CLOVING_WORKER_HOOK_TRACE: process.env["CLOVING_WORKER_HOOK_TRACE"],
        CLOVING_WORKER_HOOK_TRACE_START: workerHookTraceStart,
        CLOVING_WORKER_HOOK_TRACE_FD: "3",
      },
    },
  );
  traceWorkerHook("check:end");
  process.stderr.write(result.error?.message ?? result.stderr);
  process.exitCode = result.status === 0 && !result.error ? 0 : 2;
} catch (error) {
  process.stderr.write(
    error instanceof Error ? error.message : "worker-hook-failed",
  );
  process.exitCode = 2;
}
