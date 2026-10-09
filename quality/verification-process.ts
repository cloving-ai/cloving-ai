import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type {
  CapturedExecution,
  VerificationCommand,
} from "./verification-types.ts";
import {
  killVerificationGroup,
  stopVerificationGroup,
} from "./verification-process-group.ts";
import { collectVerificationOutput } from "./verification-output.ts";

export async function captureExecution(
  proposedCommand: VerificationCommand,
): Promise<CapturedExecution> {
  const command = structuredClone(proposedCommand);
  const child = spawn(command.executable, command.arguments, {
    cwd: command.directory,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TZ: "UTC",
      CI: "true",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
  });
  let error: string | null = null;
  const stop = (): void => {
    if (child.pid) killVerificationGroup(child.pid);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const output = collectVerificationOutput(child, () => {
    error = "verification-output-overflow";
    stop();
  });
  const timeout = setTimeout(() => {
    error = "verification-timeout";
    stop();
  }, command.timeoutMilliseconds);
  const result = await new Promise<{
    exit: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("error", (failure) => {
      error = failure.message;
    });
    child.on("close", (exit, signal) => {
      resolve({ exit, signal });
    });
  });
  clearTimeout(timeout);
  if (child.pid) await stopVerificationGroup(child.pid);
  return {
    id: command.id,
    processGroup: child.pid ?? null,
    ...result,
    error,
    ...output,
  };
}
