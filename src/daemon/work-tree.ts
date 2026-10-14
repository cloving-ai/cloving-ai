import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const executed = promisify(execFile);
const lineLimit = 30;
const lineLength = 120;

export interface WorkTree {
  readonly path: string;
  readonly branch: string;
  readonly startCommit: string;
}

export interface TreeRequest {
  readonly repository: string;
  readonly worktrees: string;
  readonly target: string;
  readonly signal: AbortSignal;
  readonly base?: string;
}

export interface Changes {
  readonly branch: string;
  readonly commits: readonly string[];
  readonly files: readonly string[];
  readonly uncommitted: readonly string[];
}

interface GitCall {
  readonly directory: string;
  readonly parts: readonly string[];
  readonly signal?: AbortSignal;
}

async function git(call: GitCall): Promise<string> {
  const { directory, parts, signal } = call;
  const { stdout } = await executed("git", ["-C", directory, ...parts], {
    ...(signal === undefined ? {} : { signal }),
  });
  return stdout;
}

export function treeName(target: string): string {
  return target
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^\.|\.$/g, "-")
    .replace(/\.lock$/, "-lock");
}

async function added(
  request: TreeRequest,
  tree: { readonly path: string; readonly branch: string },
): Promise<void> {
  const { repository, worktrees, signal } = request;
  const call = (parts: readonly string[]): Promise<string> =>
    git({ directory: repository, parts, signal });
  await call(["worktree", "prune"]);
  await mkdir(worktrees, { recursive: true });
  const known = await call([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${tree.branch}`,
  ]).then(
    () => true,
    () => false,
  );
  await call(
    known
      ? ["worktree", "add", tree.path, tree.branch]
      : [
          "worktree",
          "add",
          "-b",
          tree.branch,
          tree.path,
          request.base ?? "HEAD",
        ],
  );
}

export function treePlace(request: Pick<TreeRequest, "worktrees" | "target">): {
  readonly path: string;
  readonly branch: string;
} {
  const name = treeName(request.target);
  return { path: join(request.worktrees, name), branch: `cloving/${name}` };
}

export async function workTree(request: TreeRequest): Promise<WorkTree> {
  const { path, branch } = treePlace(request);
  if (!existsSync(join(path, ".git"))) await added(request, { path, branch });
  const head = await git({
    directory: path,
    parts: ["rev-parse", "HEAD"],
    signal: request.signal,
  });
  return { path, branch, startCommit: head.trim() };
}

export async function changes(tree: WorkTree): Promise<Changes> {
  const lines = async (parts: readonly string[]): Promise<string[]> =>
    (await git({ directory: tree.path, parts }).catch(() => ""))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(0, lineLimit)
      .map((line) => line.slice(0, lineLength));
  const range = `${tree.startCommit}..HEAD`;
  const [branch = tree.branch] = await lines([
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  return {
    branch,
    commits: await lines(["log", "--oneline", range]),
    files: await lines(["diff", "--stat", range]),
    uncommitted: await lines(["status", "--short"]),
  };
}
