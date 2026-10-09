import { setTimeout } from "node:timers/promises";

export function killVerificationGroup(identifier: number): void {
  try {
    process.kill(-identifier, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return;
    throw error;
  }
}

export async function stopVerificationGroup(identifier: number): Promise<void> {
  killVerificationGroup(identifier);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      process.kill(-identifier, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      throw error;
    }
    await setTimeout(10);
  }
  throw new Error("verification-process-group-remains");
}
