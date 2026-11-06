import {
  defaultBranch,
  field,
  repositoryPath,
  type Operation,
} from "./github-operation.ts";
import { treeName, workTree, type WorkTree } from "./work-tree.ts";

const clovingPrefix = "cloving/";

async function treeAt(
  operation: Operation,
  place: { readonly target: string; readonly base: string },
): Promise<WorkTree> {
  const { settings, signal } = operation;
  return await workTree({
    repository: settings.repository,
    worktrees: settings.worktrees,
    target: place.target,
    signal,
    base: place.base,
  }).catch(() => {
    throw new Error("work-tree-not-available");
  });
}

export async function prepare(operation: Operation): Promise<unknown> {
  const { settings, calls } = operation;
  await calls.git(settings.repository, ["fetch", "--quiet", "origin"]);
  const base = await defaultBranch(operation);
  if (Object.hasOwn(operation.payload, "pullRequest"))
    return await pullTree(operation, base);
  const tree = await treeAt(operation, {
    target: operation.target,
    base: `origin/${base}`,
  });
  return {
    branch: tree.branch,
    worktree: tree.path,
    base,
    startCommit: tree.startCommit,
  };
}

function pullNumber(operation: Operation): number {
  const number = operation.payload["pullRequest"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("invalid-payload");
  return number;
}

function clovingTarget(branch: unknown): string {
  const target =
    typeof branch === "string" && branch.startsWith(clovingPrefix)
      ? branch.slice(clovingPrefix.length)
      : "";
  if (target === "" || treeName(target) !== target)
    throw new Error("pull-request-not-cloving");
  return target;
}

async function pullHead(
  operation: Operation,
): Promise<{ readonly target: string; readonly head: string }> {
  const number = pullNumber(operation);
  const pull: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      `${repositoryPath}/pulls/${String(number)}`,
    ]),
  );
  if (field(pull, "state") !== "open") throw new Error("pull-request-not-open");
  const target = clovingTarget(field(field(pull, "head"), "ref"));
  const head = field(field(pull, "head"), "sha");
  if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/.test(head))
    throw new Error("github-call-failed");
  return { target, head };
}

async function pullTree(operation: Operation, base: string): Promise<unknown> {
  const pull = await pullHead(operation);
  const tree = await treeAt(operation, {
    target: pull.target,
    base: pull.head,
  });
  await operation.calls
    .git(tree.path, ["merge", "--ff-only", "--quiet", pull.head])
    .catch(() => {
      throw new Error("pull-request-diverged");
    });
  const head = await operation.calls.git(tree.path, ["rev-parse", "HEAD"]);
  return {
    target: pull.target,
    branch: tree.branch,
    worktree: tree.path,
    base,
    startCommit: tree.startCommit,
    head: head.trim(),
  };
}
