import { ownedIndexLock, removeStoppedIndexLock } from "./resume-index-lock.ts";
import { stopTreeProcesses } from "./worktree-processes.ts";
import { indexFailure, type IndexFailure } from "./retry-worktree.ts";

async function inspectLock(failure: IndexFailure | null) {
  if (failure?.lockPath === undefined) return undefined;
  return ownedIndexLock(failure.lockPath);
}

export async function resumeWorktree(request: {
  readonly directory: string;
  readonly folder: string;
  readonly signal: AbortSignal;
  readonly stopMilliseconds?: number;
}): Promise<IndexFailure | null> {
  const aborted = () => request.signal.aborted;
  const before = await indexFailure(request);
  const lock = await inspectLock(before);
  if (aborted()) return before;
  const stopped = await stopTreeProcesses(request);
  const locked = await indexFailure(request);
  if (!stopped)
    return (
      locked ?? {
        reason: "worktree-index-locked",
        fix: "Stop the remaining work tree processes before resuming the turn.",
      }
    );
  if (locked?.reason !== "worktree-index-locked" || aborted()) return locked;
  if (
    lock === undefined ||
    lock.path !== locked.lockPath ||
    !(await removeStoppedIndexLock(lock, request.signal))
  )
    return locked;
  return indexFailure(request);
}
