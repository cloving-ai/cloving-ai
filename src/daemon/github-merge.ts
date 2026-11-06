import { existsSync } from "node:fs";
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
import { waitForCi, type CiResult } from "./github-ci.ts";
import { githubText } from "./github-calls.ts";
import {
  recordedHead,
  savedHead,
  type RecordedHead,
} from "./github-merge-head.ts";
import {
  knownMerge,
  mergePull,
  type MergeCheck,
  type ReviewedPull,
} from "./github-merge-call.ts";

export interface SuccessfulMerge {
  readonly number: number;
  readonly commit: string;
  readonly updated: string;
  readonly merged: string;
}

interface MergeRepair {
  readonly reason: "check-failed" | "merge-conflict";
  readonly output: string;
}

export type MergeResult = SuccessfulMerge | MergeRepair | CiResult;

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
  } catch (error) {
    const conflicts = await calls.git(place.tree.path, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    await calls.git(place.tree.path, ["merge", "--abort"]);
    const output = commandOutput(error instanceof Error ? error.cause : error);
    throw Object.assign(new Error("merge-conflict", { cause: error }), {
      output: githubText(output + conflicts, operation.settings)
        .slice(-6_000)
        .trim(),
    });
  }
}

async function checked(
  operation: Operation,
  place: {
    readonly tree: Place;
    readonly base: string;
    readonly commit: string;
    readonly check?: MergeCheck | undefined;
  },
): Promise<RecordedHead> {
  await changeChecked(operation, place);
  const head = await headOf(operation, place.tree);
  const command = place.check === null ? undefined : operation.settings.check;
  if (command !== undefined)
    await operation.calls.run(command, place.tree.path);
  await clean(operation, place.tree);
  if ((await headOf(operation, place.tree)) !== head)
    throw new Error("uncommitted-change");
  if (head !== place.commit && command === undefined && place.check !== null)
    throw new Error("check-required");
  return { updated: head, checked: command !== undefined };
}

async function refreshed(
  operation: Operation,
  place: {
    readonly tree: Place;
    readonly commit: string;
    readonly recorded: RecordedHead | undefined;
    readonly check?: MergeCheck | undefined;
  },
): Promise<RecordedHead> {
  const { recorded } = place;
  await restored(operation, {
    tree: place.tree,
    commit: recorded?.updated ?? place.commit,
  });
  const base = await defaultBranch(operation);
  let newest = await fetched(operation, base);
  if (
    recorded !== undefined &&
    (
      await operation.calls.git(place.tree.path, [
        "merge-base",
        recorded.updated,
        newest,
      ])
    ).trim() === newest
  )
    return recorded.checked
      ? recorded
      : await checked(operation, { ...place, base });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await updatedTree(operation, { tree: place.tree, base: newest });
    const head = await checked(operation, { ...place, base });
    const latest = await fetched(operation, base);
    if (latest === newest) return head;
    newest = latest;
  }
  throw new Error("base-moved");
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

async function readyHead(
  operation: Operation,
  pull: ReviewedPull & {
    readonly recorded: RecordedHead | undefined;
    readonly remote: string;
  },
): Promise<{ readonly updated: string; readonly merged: string } | CiResult> {
  const tree = existingTree(operation);
  let recorded = pull.recorded;
  let remote = pull.remote;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const head = await pushedHead(operation, {
      ...pull,
      tree,
      recorded,
      remote,
    });
    const { updated } = head;
    const ci = await waitForCi(operation, updated);
    if (ci !== undefined) return ci;
    recorded = head;
    remote = updated;
    if (!(await containsBase(operation, updated))) continue;

    const merged = await mergePull(operation, { ...pull, updated });
    if (typeof merged === "string") return { updated, merged };
    if (await containsBase(operation, updated)) throw merged;
    await recordRefusal(operation, { error: merged, updated, attempt });
  }
  throw new Error("base-moved");
}

async function recordRefusal(
  operation: Operation,
  refusal: {
    readonly error: Error;
    readonly updated: string;
    readonly attempt: number;
  },
): Promise<void> {
  const observation = await operation.observe?.({
    notice: `merge-refused:${String(refusal.attempt + 1)}`,
    condition: "working",
    reason: "github-merge-refused",
    evidence: `github-merge/HTTP-${String(field(refusal.error, "status"))}/head-${refusal.updated}/merge-main`,
    attempt: refusal.attempt + 1,
    limit: 3,
  });
  if (
    observation !== undefined &&
    !["accepted", "duplicate"].includes(observation.kind)
  )
    throw new Error("github-call-failed");
}

async function pushedHead(
  operation: Operation,
  pull: ReviewedPull & {
    readonly tree: Place;
    readonly recorded: RecordedHead | undefined;
    readonly remote: string;
  },
): Promise<RecordedHead> {
  const head = await refreshed(operation, pull);
  const { updated } = head;
  if (updated !== pull.commit && changedHead(pull.recorded, head))
    await savedHead(operation, {
      commit: pull.commit,
      updated,
      checked: head.checked,
    });
  if (updated !== pull.commit && pull.remote !== updated)
    await operation.calls.git(pull.tree.path, [
      "push",
      "--quiet",
      "origin",
      `${updated}:refs/heads/${pull.tree.branch}`,
    ]);
  return head;
}

function changedHead(
  recorded: RecordedHead | undefined,
  head: RecordedHead,
): boolean {
  return (
    recorded?.updated !== head.updated || recorded.checked !== head.checked
  );
}

async function containsBase(
  operation: Operation,
  updated: string,
): Promise<boolean> {
  const newest = await fetched(operation, await defaultBranch(operation));
  return (
    (
      await operation.calls.git(existingTree(operation).path, [
        "merge-base",
        updated,
        newest,
      ])
    ).trim() === newest
  );
}

function checkOutput(cause: unknown): string {
  return commandOutput(cause).slice(-6_000);
}

function commandOutput(cause: unknown): string {
  return ["stdout", "stderr"]
    .map((name) => {
      const value = field(cause, name);
      return typeof value === "string" ? value : "";
    })
    .join("");
}

export function requireCheck(operation: Operation, pull: ReviewedPull): void {
  if (pull.check === "beforeMerge" && operation.settings.check === undefined)
    throw new Error("check-not-configured");
}

export function mergeRepair(operation: Operation, error: unknown): MergeRepair {
  operation.signal.throwIfAborted();
  if (!(error instanceof Error)) throw error;
  const reason = error.message;
  if (reason !== "check-failed" && reason !== "merge-conflict") throw error;
  const detail = field(error, "output");
  const conflicts = typeof detail === "string" ? detail : "";
  return {
    reason,
    output:
      reason === "check-failed"
        ? checkOutput(error.cause)
        : githubText(conflicts, operation.settings),
  };
}

export async function merge(
  operation: Operation,
  pull: ReviewedPull,
): Promise<MergeResult> {
  requireCheck(operation, pull);
  try {
    return await completedMerge(operation, pull);
  } catch (error) {
    return mergeRepair(operation, error);
  }
}

export async function checkedLocally(
  operation: Operation,
  pull: ReviewedPull,
): Promise<void> {
  const tree = existingTree(operation);
  await refreshed(operation, { ...pull, tree, recorded: undefined });
  await restored(operation, { tree, commit: pull.commit });
}

export async function conflictChecked(
  operation: Operation,
  commit: string,
): Promise<void> {
  const tree = existingTree(operation);
  await restored(operation, { tree, commit });
  const base = await fetched(operation, await defaultBranch(operation));
  await updatedTree(operation, { tree, base });
  await restored(operation, { tree, commit });
}

export async function finishedMerge(
  operation: Operation,
  result: SuccessfulMerge,
): Promise<SuccessfulMerge> {
  await removed(
    operation,
    treePlace({
      worktrees: operation.settings.worktrees,
      target: operation.target,
    }),
  );
  return result;
}

async function completedMerge(
  operation: Operation,
  pull: ReviewedPull,
): Promise<SuccessfulMerge | CiResult> {
  const recorded = await recordedHead(operation, pull.commit);
  const updated = recorded?.updated ?? pull.commit;
  const known = await knownMerge(operation, { ...pull, updated });
  const result =
    known.merged === undefined
      ? await readyHead(operation, { ...pull, recorded, remote: known.head })
      : { updated, merged: known.merged };
  if ("reason" in result) return result;
  return finishedMerge(operation, {
    number: pull.number,
    commit: pull.commit,
    ...result,
  });
}
