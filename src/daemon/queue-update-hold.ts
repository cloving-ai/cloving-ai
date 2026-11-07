import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueJournal } from "./queue-journal.ts";

async function pendingUpdate(directory: string): Promise<string | undefined> {
  return readFile(join(directory, "pending-self-update"), "utf8").catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
}

async function holdStarted(
  pending: QueueJournal,
  observed: { readonly mark: string; readonly activeRuns: number },
): Promise<number> {
  const { mark, activeRuns } = observed;
  const timestamp = Number(mark);
  if (!Number.isFinite(timestamp) || timestamp <= 0)
    throw new Error("invalid-pending-self-update");
  if (pending.selfUpdateHold?.mark !== mark || activeRuns > 0) {
    pending.selfUpdateHold = { mark, startedAt: Date.now() };
    await pending.save();
  }
  return pending.selfUpdateHold.startedAt;
}

export function updateHold(
  directory: string,
  pending: QueueJournal,
): (activeRuns?: number) => Promise<boolean> {
  let notice: string | undefined;
  return async (activeRuns = 0) => {
    const mark = await pendingUpdate(directory);
    if (mark === undefined && pending.selfUpdateHold !== undefined) {
      pending.selfUpdateHold = undefined;
      await pending.save();
    }
    if (mark === undefined) {
      notice = undefined;
      return false;
    }
    const startedAt = await holdStarted(pending, { mark, activeRuns });
    const holding = activeRuns > 0 || Date.now() - startedAt < 30 * 60 * 1000;
    const line = holding
      ? "Queue holding for pending self-update\n"
      : "Queue continuing after pending self-update time limit\n";
    const key = mark + line;
    if (notice !== key) process.stderr.write(line);
    notice = key;
    return holding;
  };
}
