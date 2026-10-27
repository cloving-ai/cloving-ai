import { spawn, type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

export interface RetryTree {
  readonly directory: string;
  readonly signal: AbortSignal;
}

interface GitResult {
  readonly text: string;
  readonly code: number | null;
}

function kill(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function retryGit(
  tree: RetryTree,
  parts: readonly string[],
): Promise<GitResult> {
  if (tree.signal.aborted) return { text: "", code: null };
  const child = spawn("git", ["-C", tree.directory, ...parts], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const closed = Promise.withResolvers<number | null>();
  let text = "";
  const stop = (): void => {
    kill(child);
    child.stdout.destroy();
    closed.resolve(null);
  };
  const timer = setTimeout(stop, 30_000);
  tree.signal.addEventListener("abort", stop, { once: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    text += chunk;
    if (Buffer.byteLength(text) > 1_048_576) stop();
  });
  child.once("error", () => {
    closed.resolve(null);
  });
  child.once("close", closed.resolve);
  const code = await closed.promise;
  clearTimeout(timer);
  tree.signal.removeEventListener("abort", stop);
  return { text: text.trim(), code };
}

export async function turnHead(tree: RetryTree): Promise<string | null> {
  const head = await retryGit(tree, ["rev-parse", "--verify", "HEAD"]);
  return head.code === 0 && /^[a-f0-9]{40,64}$/.test(head.text)
    ? head.text
    : null;
}

async function remoteState(tree: RetryTree): Promise<string> {
  const branch = await retryGit(tree, ["symbolic-ref", "--short", "HEAD"]);
  if (branch.code !== 0 || tree.signal.aborted) return "unknown";
  const reference = `refs/heads/${branch.text}`;
  const remote = await retryGit(tree, [
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    reference,
  ]);
  if (remote.code === 2) return "not pushed";
  if (remote.code !== 0) return "unknown";
  const tracking = `refs/remotes/origin/${branch.text}`;
  const fetched = await retryGit(tree, [
    "fetch",
    "--no-tags",
    "origin",
    `+${reference}:${tracking}`,
  ]);
  return fetched.code === 0 ? tracking : "unknown";
}

async function pushState(
  tree: RetryTree,
  evidence: { readonly commit: string; readonly remote: string },
): Promise<string> {
  const { commit, remote } = evidence;
  if (!remote.startsWith("refs/")) return remote;
  const ancestor = await retryGit(tree, [
    "merge-base",
    "--is-ancestor",
    commit,
    remote,
  ]);
  if (ancestor.code === 1) return "not pushed";
  return ancestor.code === 0 ? "pushed" : "unknown";
}

export async function retryEvidence(
  tree: RetryTree,
  startCommit: string | null,
): Promise<string> {
  const remote = await remoteState(tree);
  if (startCommit === null || tree.signal.aborted)
    return "unknown: commits since the start of this turn could not be determined.";
  const commits = await retryGit(tree, [
    "log",
    "--format=%H %s",
    `${startCommit}..HEAD`,
    "--",
  ]);
  if (commits.code !== 0)
    return "unknown: commits since the start of this turn could not be listed.";
  const lines: string[] = [];
  for (const line of commits.text.split("\n").filter(Boolean)) {
    const commit = line.split(" ")[0] ?? "";
    const state = await pushState(tree, { commit, remote });
    lines.push(`${commit} ${state}${line.slice(commit.length)}`);
  }
  if (lines.length > 0) return lines.join("\n");
  return remote === "unknown"
    ? "unknown: remote push state could not be determined; no local commits since the start of this turn."
    : "No commits since the start of this turn.";
}

export interface IndexFailure {
  readonly reason: "worktree-index-unknown" | "worktree-index-locked";
  readonly lockPath?: string;
  readonly fix: string;
}

export async function indexFailure(
  tree: RetryTree,
): Promise<IndexFailure | null> {
  const lookup = await retryGit(tree, [
    "rev-parse",
    "--git-path",
    "index.lock",
  ]);
  const unknown: IndexFailure = {
    reason: "worktree-index-unknown",
    fix: "Check that the work tree and its git index path are accessible before starting another turn.",
  };
  if (lookup.code !== 0 || lookup.text === "") return unknown;
  const lockPath = resolve(tree.directory, lookup.text);
  try {
    await lstat(lockPath);
    return {
      reason: "worktree-index-locked",
      lockPath,
      fix: "Remove the index lock when no git process uses the work tree, then start another turn.",
    };
  } catch (error) {
    return Reflect.get(Object(error), "code") === "ENOENT" ? null : unknown;
  }
}
