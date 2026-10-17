import { readFileSync } from "node:fs";
import { evaluateWorkerHook } from "../quality/worker-hooks.ts";
import { readWorkerHookPolicy } from "../quality/worker-hook-input.ts";
import { readWorkerHookInput } from "../quality/worker-hook-stdin.ts";
import { traceWorkerHook } from "../quality/worker-hook-trace.ts";

try {
  const policy = process.argv[2];
  if (!policy) throw new Error("missing-worker-hook-policy");
  const input: unknown = JSON.parse(
    (await readWorkerHookInput(process.stdin)).toString("utf8"),
  );
  const configuration = readWorkerHookPolicy(
    JSON.parse(readFileSync(policy, "utf8")),
  );
  traceWorkerHook("input-policy:read");
  const result = await evaluateWorkerHook(input, configuration);
  process.stderr.write(result.diagnostic);
  process.exitCode = result.exit;
} catch (error) {
  process.stderr.write(
    error instanceof Error ? error.message : "worker-hook-failed",
  );
  process.exitCode = 2;
}
