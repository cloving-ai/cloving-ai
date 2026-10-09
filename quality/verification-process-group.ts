import { setTimeout } from "node:timers/promises";

type Signal = (identifier: number, signal: NodeJS.Signals | 0) => true;

const send: Signal = (identifier, signal) => process.kill(identifier, signal);

export function killVerificationGroup(
  identifier: number,
  signal: Signal = send,
): void {
  try {
    signal(-identifier, "SIGKILL");
  } catch (error) {
    if (["ESRCH", "EPERM"].includes(errorCode(error))) return;
    throw error;
  }
}

export async function stopVerificationGroup(
  identifier: number,
  signal: Signal = send,
): Promise<void> {
  killVerificationGroup(identifier, signal);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      signal(-identifier, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return;
      if (errorCode(error) !== "EPERM") throw error;
    }
    await setTimeout(10);
  }
  throw new Error("verification-process-group-remains");
}

function errorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "";
}
