import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
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
  if (request.target.startsWith("branch:"))
    return branchTree(request).catch((error: unknown) => {
      const reason = treeFailure(error);
      throw new Error(
        reason === "work-tree-not-available"
          ? "branch-worktree-not-found"
          : reason,
      );
    });
  const { path, branch } = treePlace(request);
  if (!existsSync(join(path, ".git"))) await added(request, { path, branch });
  const head = await git({
    directory: path,
    parts: ["rev-parse", "HEAD"],
    signal: request.signal,
  });
  return { path, branch, startCommit: head.trim() };
}

async function branchTree(request: TreeRequest): Promise<WorkTree> {
  const branch = request.target.slice("branch:".length);
  if (branch.startsWith("cloving/")) throw new Error("branch-reserved");
  const listing = await git({
    directory: request.repository,
    parts: ["worktree", "list", "--porcelain", "-z"],
    signal: request.signal,
  });
  const entry = listing
    .split("\0\0")
    .slice(1)
    .find((record) =>
      record.split("\0").includes(`branch refs/heads/${branch}`),
    );
  const path = entry?.split("\0")[0]?.slice("worktree ".length);
  if (path === undefined) throw new Error("branch-worktree-not-found");
  await sameBranch(request, { path, branch });
  await outsideManaged(request, path);
  await cleanBranch({ directory: path, signal: request.signal });
  const head = await git({
    directory: path,
    parts: ["rev-parse", "HEAD"],
    signal: request.signal,
  });
  return { path, branch, startCommit: head.trim() };
}

async function outsideManaged(
  request: TreeRequest,
  path: string,
): Promise<void> {
  const folder = await realpath(request.worktrees).catch((error: unknown) => {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    return resolve(request.worktrees);
  });
  const location = relative(folder, await realpath(path));
  if (location !== ".." && !location.startsWith(`..${sep}`))
    throw new Error("branch-reserved");
}

async function sameBranch(
  request: TreeRequest,
  tree: Pick<WorkTree, "path" | "branch">,
): Promise<void> {
  const common = async (directory: string): Promise<string> => {
    const folder = await git({
      directory,
      parts: ["rev-parse", "--git-common-dir"],
      signal: request.signal,
    });
    return realpath(resolve(directory, folder.trim()));
  };
  if ((await common(request.repository)) !== (await common(tree.path)))
    throw new Error("branch-worktree-not-found");
  const head = await git({
    directory: tree.path,
    parts: ["symbolic-ref", "--quiet", "HEAD"],
    signal: request.signal,
  });
  if (head.trim() !== `refs/heads/${tree.branch}`)
    throw new Error("branch-worktree-not-found");
}

async function cleanBranch(place: Omit<GitCall, "parts">): Promise<void> {
  await cleanOutput(
    {
      ...place,
      parts: [
        "-c",
        "core.fileMode=true",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
    },
    hasOutput,
  );
  await cleanOutput({ ...place, parts: ["ls-files", "-v", "-z"] }, hiddenIndex);
}

async function hasOutput(output: AsyncIterable<Buffer>): Promise<boolean> {
  let present = false;
  for await (const chunk of output) {
    if (chunk.length > 0) present = true;
  }
  return present;
}

async function hiddenIndex(output: AsyncIterable<Buffer>): Promise<boolean> {
  let entryStart = true;
  let hidden = false;
  for await (const chunk of output) {
    for (const character of chunk.toString()) {
      if (entryStart && /[a-zS]/.test(character)) hidden = true;
      entryStart = character === "\0";
    }
  }
  return hidden;
}

async function cleanOutput(
  call: GitCall,
  inspect: (output: AsyncIterable<Buffer>) => Promise<boolean>,
): Promise<void> {
  const child = spawn("git", ["-C", call.directory, ...call.parts], {
    stdio: ["ignore", "pipe", "ignore"],
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  });
  const ended = new Promise<boolean>((resolve) => {
    child.once("error", () => {
      resolve(false);
    });
    child.once("close", (code) => {
      resolve(code === 0);
    });
  });
  const dirty = await inspect(child.stdout);
  if (!(await ended)) throw new Error("branch-worktree-not-found");
  if (dirty) throw new Error("branch-worktree-not-clean");
}

export function treeFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : "";
  return [
    "branch-worktree-not-found",
    "branch-worktree-not-clean",
    "branch-reserved",
  ].includes(reason)
    ? reason
    : "work-tree-not-available";
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
