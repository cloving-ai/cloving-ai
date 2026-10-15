import { existsSync } from "node:fs";
import { readRecord, writeRecord } from "./operation-journal.ts";
import {
  changeChecked,
  defaultBranch,
  existingTree,
  field,
  removeWorktree,
  repositoryPath,
  type Operation,
  type Place,
} from "./github-operation.ts";
import { treePlace } from "./work-tree.ts";

interface ReviewedPull {
  readonly number: number;
  readonly commit: string;
}

function commitOf(value: unknown, name: string): string {
  if (typeof value !== "object" || value === null)
    throw new Error("github-call-failed");
  const commit: unknown = Reflect.get(value, name);
  if (typeof commit !== "string") throw new Error("github-call-failed");
  return commit;
}

async function knownMerge(
  operation: Operation,
  expected: ReviewedPull & { readonly updated: string },
): Promise<{ readonly head: string; readonly merged: string | undefined }> {
  const pull: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      `${repositoryPath}/pulls/${String(expected.number)}`,
    ]),
  );
  const head = commitOf(field(pull, "head"), "sha");
  if (field(pull, "merged") !== true) return { head, merged: undefined };
  if (head !== expected.commit && head !== expected.updated)
    throw new Error("merged-other-commit");
  return { head, merged: commitOf(pull, "merge_commit_sha") };
}

async function abortMerge(operation: Operation, tree: Place): Promise<void> {
  const path = (
    await operation.calls.git(tree.path, [
      "rev-parse",
      "--git-path",
      "MERGE_HEAD",
    ])
  ).trim();
  if (existsSync(path))
    await operation.calls.git(tree.path, ["merge", "--abort"]);
}

async function restored(
  operation: Operation,
  place: { readonly tree: Place; readonly commit: string },
): Promise<void> {
  await abortMerge(operation, place.tree);
  await clean(operation, place.tree);
  if ((await headOf(operation, place.tree)) === place.commit) return;
  await operation.calls.git(place.tree.path, ["reset", "--hard", place.commit]);
}

async function clean(operation: Operation, tree: Place): Promise<void> {
  const status = await operation.calls.git(tree.path, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (status.trim() !== "") throw new Error("uncommitted-change");
}

async function headOf(operation: Operation, tree: Place): Promise<string> {
  return (await operation.calls.git(tree.path, ["rev-parse", "HEAD"])).trim();
}

async function fetched(operation: Operation, base: string): Promise<string> {
  const { calls, settings } = operation;
  await calls.git(settings.repository, ["fetch", "--quiet", "origin"]);
  return (
    await calls.git(settings.repository, ["rev-parse", `origin/${base}`])
  ).trim();
}

async function updatedTree(
  operation: Operation,
  place: { readonly tree: Place; readonly base: string },
): Promise<void> {
  const { calls } = operation;
  const ancestor = (
    await calls.git(place.tree.path, ["merge-base", "HEAD", place.base])
  ).trim();
  if (ancestor === place.base) return;
  try {
    await calls.git(place.tree.path, [
      "merge",
      "--no-ff",
      "--no-edit",
      place.base,
    ]);
  } catch {
    const conflicts = await calls.git(place.tree.path, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    await calls.git(place.tree.path, ["merge", "--abort"]);
    throw new Error("merge-conflict", { cause: conflicts.trim() });
  }
}

async function checked(
  operation: Operation,
  place: {
    readonly tree: Place;
    readonly base: string;
    readonly commit: string;
  },
): Promise<string> {
  await changeChecked(operation, place);
  const head = await headOf(operation, place.tree);
  if (operation.settings.check !== undefined)
    await operation.calls.run(operation.settings.check, place.tree.path);
  await clean(operation, place.tree);
  if ((await headOf(operation, place.tree)) !== head)
    throw new Error("uncommitted-change");
  if (head !== place.commit && operation.settings.check === undefined)
    throw new Error("check-required");
  return head;
}

async function refreshed(
  operation: Operation,
  place: {
    readonly tree: Place;
    readonly commit: string;
    readonly recorded: string | undefined;
  },
): Promise<string> {
  await restored(operation, {
    tree: place.tree,
    commit: place.recorded ?? place.commit,
  });
  const base = await defaultBranch(operation);
  let newest = await fetched(operation, base);
  if (
    place.recorded !== undefined &&
    (
      await operation.calls.git(place.tree.path, [
        "merge-base",
        place.recorded,
        newest,
      ])
    ).trim() === newest
  )
    return place.recorded;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await updatedTree(operation, { tree: place.tree, base: newest });
    const head = await checked(operation, { ...place, base });
    const latest = await fetched(operation, base);
    if (latest === newest) return head;
    newest = latest;
  }
  throw new Error("base-moved");
}

async function mergedNow(
  operation: Operation,
  pull: ReviewedPull,
): Promise<string> {
  const reply: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      "-X",
      "PUT",
      `${repositoryPath}/pulls/${String(pull.number)}/merge`,
      "-f",
      "merge_method=merge",
      "-f",
      `sha=${pull.commit}`,
    ]),
  );
  return commitOf(reply, "sha");
}

async function removed(operation: Operation, place: Place): Promise<void> {
  const { settings, calls } = operation;
  await calls
    .gh([
      "api",
      "-X",
      "DELETE",
      `${repositoryPath}/git/refs/heads/${place.branch}`,
    ])
    .catch(() => undefined);
  await removeWorktree(operation, place);
  await calls.git(settings.repository, [
    "update-ref",
    "-d",
    `refs/remotes/origin/${place.branch}`,
  ]);
}

async function recordedHead(
  operation: Operation,
  commit: string,
): Promise<string | undefined> {
  const record = await readRecord(operation.folder, "updated-head.json");
  if (record === undefined) return undefined;
  const updated = field(record, "updated");
  if (
    field(record, "commit") !== commit ||
    typeof updated !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(updated)
  )
    throw new Error("git-call-failed");
  return updated;
}

async function readyHead(
  operation: Operation,
  pull: ReviewedPull & {
    readonly recorded: string | undefined;
    readonly remote: string;
  },
): Promise<string> {
  const tree = existingTree(operation);
  const updated = await refreshed(operation, {
    tree,
    commit: pull.commit,
    recorded: pull.recorded,
  });
  if (updated === pull.commit) return updated;
  if (pull.recorded !== updated)
    await writeRecord(operation.folder, {
      name: "updated-head.json",
      value: { commit: pull.commit, updated },
    });
  if (pull.remote !== updated)
    await operation.calls.git(tree.path, [
      "push",
      "--quiet",
      "origin",
      `${updated}:refs/heads/${tree.branch}`,
    ]);
  return updated;
}

function checkOutput(cause: unknown): string {
  return ["stdout", "stderr"]
    .map((name) => {
      const value = field(cause, name);
      return typeof value === "string" ? value : "";
    })
    .join("")
    .slice(-6_000);
}

export async function merge(
  operation: Operation,
  pull: ReviewedPull,
): Promise<unknown> {
  try {
    return await completedMerge(operation, pull);
  } catch (error) {
    operation.signal.throwIfAborted();
    if (
      !(error instanceof Error) ||
      !["check-failed", "merge-conflict"].includes(error.message)
    )
      throw error;
    const conflicts = typeof error.cause === "string" ? error.cause : "";
    return {
      reason: error.message,
      output:
        error.message === "check-failed" ? checkOutput(error.cause) : conflicts,
    };
  }
}

async function completedMerge(
  operation: Operation,
  pull: ReviewedPull,
): Promise<unknown> {
  const place = treePlace({
    worktrees: operation.settings.worktrees,
    target: operation.target,
  });
  const recorded = await recordedHead(operation, pull.commit);
  const known = await knownMerge(operation, {
    ...pull,
    updated: recorded ?? pull.commit,
  });
  const updated =
    known.merged === undefined
      ? await readyHead(operation, { ...pull, recorded, remote: known.head })
      : (recorded ?? pull.commit);
  const merged =
    known.merged ?? (await mergedNow(operation, { ...pull, commit: updated }));
  await removed(operation, place);
  return { number: pull.number, commit: pull.commit, updated, merged };
}
