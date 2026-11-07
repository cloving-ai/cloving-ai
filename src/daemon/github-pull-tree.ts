import { constants, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
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

export const lessonsLimits = {
  folder: ".cloving",
  file: "lessons.md",
  textBytes: 16_384,
};

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
  const lessons = lessonsRequested(operation);
  await calls.git(settings.repository, ["fetch", "--quiet", "origin"]);
  const base = await defaultBranch(operation);
  const prepared = Object.hasOwn(operation.payload, "pullRequest")
    ? await pullTree(operation, base)
    : await baseTree(operation, base);
  if (!lessons) return prepared;
  return { ...prepared, lessons: await treeLessons(prepared.worktree) };
}

async function baseTree(operation: Operation, base: string) {
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

function lessonsRequested(operation: Operation): boolean {
  if (!Object.hasOwn(operation.payload, "lessons")) return false;
  if (operation.payload["lessons"] === true) return true;
  throw new Error("invalid-payload");
}

function entryKind(path: string): "missing" | "folder" | "file" | "other" {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return "missing";
  if (entry.isDirectory()) return "folder";
  return entry.isFile() ? "file" : "other";
}

async function treeLessons(
  tree: string,
): Promise<{ readonly text: string; readonly bytes: number }> {
  const folder = join(tree, lessonsLimits.folder);
  const file = join(folder, lessonsLimits.file);
  const folderKind = entryKind(folder);
  if (folderKind === "missing") return { text: "", bytes: 0 };
  const fileKind = folderKind === "folder" ? entryKind(file) : "other";
  if (fileKind === "missing") return { text: "", bytes: 0 };
  if (fileKind !== "file") throw new Error("lessons-not-a-file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(lessonsLimits.textBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const { size } = await handle.stat();
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: size,
    };
  } finally {
    await handle.close();
  }
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

async function pullTree(operation: Operation, base: string) {
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
