import { setTimeout as delay } from "node:timers/promises";
import type { Calls } from "./github-calls.ts";
import { field, type Operation } from "./github-operation.ts";

const waits: readonly number[] = [5_000, 15_000, 45_000];
const remoteCommands: ReadonlySet<string> = new Set([
  "fetch",
  "push",
  "ls-remote",
]);
const transientOutputs: readonly RegExp[] = [
  /Could not read from remote repository/i,
  /Permission denied \(publickey\)/i,
  /Connection reset/i,
  /Connection timed out/i,
  /Could not resolve host/i,
  /The remote end hung up unexpectedly/i,
  /early EOF/i,
  /\b(?:HTTP|returned error:) 5\d\d\b/i,
];
const lastingOutputs: readonly RegExp[] = [
  /does not appear to be a git repository/i,
];

function transient(detail: string): boolean {
  if (lastingOutputs.some((pattern) => pattern.test(detail))) return false;
  return transientOutputs.some((pattern) => pattern.test(detail));
}

interface Retry {
  readonly operation: Operation;
  readonly directory: string;
  readonly parts: readonly string[];
  readonly started: number;
}

async function attempted(
  retry: Retry,
  attempt: number,
): Promise<string | undefined> {
  const { calls, signal, observe } = retry.operation;
  try {
    return await calls.git(retry.directory, retry.parts);
  } catch (error) {
    signal.throwIfAborted();
    const detail = String(field(error, "detail"));
    if (!transient(detail)) throw error;
    const milliseconds = waits[attempt];
    if (milliseconds === undefined)
      throw Object.assign(new Error("git-network-failed", { cause: error }), {
        detail,
      });
    await observe?.({
      notice: `git-retry:${String(retry.started)}:${String(attempt + 1)}`,
      condition: "working",
      reason: "git-network-retry",
      evidence: `git/${String(retry.parts[0])}`,
      retryAt: new Date(Date.now() + milliseconds).toISOString(),
      attempt: attempt + 1,
      limit: waits.length,
    });
    await delay(milliseconds, undefined, { signal });
    return undefined;
  }
}

async function cleared(retry: Retry): Promise<void> {
  if (retry.operation.signal.aborted) return;
  await retry.operation.observe?.({
    notice: `git-retry:${String(retry.started)}:done`,
    condition: "working",
    reason: "in-progress",
  });
}

async function recovered(retry: Retry): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const output = await attempted(retry, attempt);
    if (output !== undefined) return output;
  }
}

async function retried(retry: Retry): Promise<string> {
  const output = await attempted(retry, 0);
  if (output !== undefined) return output;
  try {
    return await recovered(retry);
  } finally {
    await cleared(retry);
  }
}

function remoteGit(operation: Operation): Calls["git"] {
  return (directory, parts) =>
    remoteCommands.has(String(parts[0]))
      ? retried({ operation, directory, parts, started: Date.now() })
      : operation.calls.git(directory, parts);
}

export function retriedOperation(operation: Operation): Operation {
  return {
    ...operation,
    calls: { ...operation.calls, git: remoteGit(operation) },
  };
}
