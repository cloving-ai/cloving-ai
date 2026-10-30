import { unlink } from "node:fs/promises";
import { stopTreeProcesses } from "./worktree-processes.ts";
import { indexFailure, type IndexFailure } from "./retry-worktree.ts";

export async function resumeWorktree(request: {
  readonly directory: string;
  readonly folder: string;
  readonly signal: AbortSignal;
  readonly stopMilliseconds?: number;
}): Promise<IndexFailure | null> {
  const stopped = await stopTreeProcesses(request);
  const locked = await indexFailure(request);
  if (!stopped)
    return (
      locked ?? {
        reason: "worktree-index-locked",
        fix: "Stop the remaining work tree processes before resuming the turn.",
      }
    );
  if (locked?.reason !== "worktree-index-locked" || request.signal.aborted)
    return locked;
  try {
    if (locked.lockPath !== undefined) await unlink(locked.lockPath);
  } catch {
    return locked;
  }
  return indexFailure(request);
}
