import { dirname, join } from "node:path";
import {
  activeRun,
  defaultBranch,
  field,
  repositoryPath,
  type Operation,
} from "./github-operation.ts";
import { operationKey, readRecord, writeRecord } from "./operation-journal.ts";
import { releaseClaim, takeClaim } from "./tree-claims.ts";
import { treeClaim, treeName, workTree, type WorkTree } from "./work-tree.ts";

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

async function ownedPull(operation: Operation, target: string): Promise<void> {
  const { run } = operation;
  const folder = join(dirname(operation.folder), "claims");
  const name = `${operationKey(target)}.json`;
  const owner = field(await readRecord(folder, name), "runId");
  if (
    typeof owner === "string" &&
    owner !== run.runId &&
    activeRun(await run.status(owner))
  )
    throw new Error("pull-request-claimed");
  await writeRecord(folder, { name, value: { target, runId: run.runId } });
}

async function claimedPull(
  operation: Operation,
  target: string,
): Promise<void> {
  const claim = treeClaim({ worktrees: operation.settings.worktrees, target });
  if (!(await takeClaim(claim))) throw new Error("pull-request-claimed");
  try {
    await ownedPull(operation, target);
  } finally {
    await releaseClaim(claim);
  }
}

async function headReached(
  operation: Operation,
  tree: { readonly path: string; readonly head: string },
): Promise<void> {
  const { git } = operation.calls;
  const contained = await git(tree.path, [
    "merge-base",
    "--is-ancestor",
    tree.head,
    "HEAD",
  ]).then(
    () => true,
    () => false,
  );
  if (contained) return;
  await git(tree.path, ["merge", "--ff-only", "--quiet", tree.head]).catch(
    () => {
      throw new Error("pull-request-diverged");
    },
  );
}

async function pullTree(operation: Operation, base: string): Promise<unknown> {
  const pull = await pullHead(operation);
  await claimedPull(operation, pull.target);
  const tree = await treeAt(operation, {
    target: pull.target,
    base: pull.head,
  });
  await headReached(operation, { path: tree.path, head: pull.head });
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
