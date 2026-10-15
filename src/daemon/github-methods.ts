import { setTimeout as delay } from "node:timers/promises";
import { findingsOf, scoreOf } from "./github-calls.ts";
import { merge } from "./github-merge.ts";
import { createIssue, discard } from "./github-issue-methods.ts";
import {
  existingTree,
  defaultBranch,
  changeChecked,
  field,
  githubTiming,
  repositoryPath,
  text,
  type Operation,
  type Place,
  type Pull,
} from "./github-operation.ts";
export type { GithubTiming, MethodSettings } from "./github-operation.ts";
import { workTree } from "./work-tree.ts";

const triggerText = "@greptileai";

export const methodReasons: ReadonlySet<string> = new Set([
  "draft-not-available",
  "invalid-draft",
  "post-uncertain",
  "private-texts-not-set",
  "github-call-failed",
  "git-call-failed",
  "check-failed",
  "merge-conflict",
  "check-required",
  "base-moved",
  "uncommitted-change",
  "invalid-payload",
  "merged-other-commit",
  "no-change",
  "private-path-in-change",
  "review-not-received",
  "work-tree-not-available",
]);

function integer(operation: Operation, name: string): number {
  const value = operation.payload[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error("invalid-payload");
  return value;
}

async function prepare(operation: Operation): Promise<unknown> {
  const { settings, calls, target, signal } = operation;
  await calls.git(settings.repository, ["fetch", "--quiet", "origin"]);
  const base = await defaultBranch(operation);
  const tree = await workTree({
    repository: settings.repository,
    worktrees: settings.worktrees,
    target,
    signal,
    base: `origin/${base}`,
  }).catch(() => {
    throw new Error("work-tree-not-available");
  });
  return {
    branch: tree.branch,
    worktree: tree.path,
    base,
    startCommit: tree.startCommit,
  };
}

async function pullOf(
  operation: Operation,
  branch: string,
): Promise<Pull | undefined> {
  const listed: unknown = JSON.parse(
    await operation.calls.gh([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url",
    ]),
  );
  const first: unknown = Array.isArray(listed) ? listed[0] : undefined;
  if (first === undefined) return undefined;
  return {
    number: Number(field(first, "number")),
    url: String(field(first, "url")),
  };
}

async function created(
  operation: Operation,
  place: { readonly tree: Place; readonly base: string },
): Promise<Pull> {
  const printed = await operation.calls.gh([
    "pr",
    "create",
    "--head",
    place.tree.branch,
    "--base",
    place.base,
    "--title",
    text(operation, "title"),
    "--body",
    text(operation, "body"),
  ]);
  const url = printed.trim().split("\n").at(-1) ?? "";
  const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error("github-call-failed");
  return { number, url };
}

async function openPull(operation: Operation): Promise<unknown> {
  const tree = existingTree(operation);
  const base = await defaultBranch(operation);
  await changeChecked(operation, { tree, base });
  await operation.calls.git(tree.path, [
    "push",
    "--quiet",
    "origin",
    `HEAD:refs/heads/${tree.branch}`,
  ]);
  const commit = (
    await operation.calls.git(tree.path, ["rev-parse", "HEAD"])
  ).trim();
  const pull =
    (await pullOf(operation, tree.branch)) ??
    (await created(operation, { tree, base }));
  return { number: pull.number, url: pull.url, commit };
}

async function reviewed(
  operation: Operation,
  pull: { readonly number: number; readonly commit: string },
): Promise<unknown> {
  const { number, commit } = pull;
  const read = async (path: string): Promise<unknown> => {
    const value: unknown = JSON.parse(
      await operation.calls.gh(["api", `${repositoryPath}/${path}`]),
    );
    return value;
  };
  const scored = scoreOf(
    await read(`issues/${String(number)}/comments?per_page=100`),
    commit,
  );
  if (scored === undefined) return undefined;
  const lines = await read(`pulls/${String(number)}/comments?per_page=100`);
  return { number, commit, ...scored, findings: findingsOf(lines, commit) };
}

async function waitReview(operation: Operation): Promise<unknown> {
  const pull = {
    number: integer(operation, "number"),
    commit: text(operation, "commit"),
  };
  const timing = operation.settings.timing ?? githubTiming;
  const startedAt = Date.now();
  let triggered = false;
  for (;;) {
    const review = await reviewed(operation, pull).catch(() => undefined);
    if (review !== undefined) return review;
    const waited = Date.now() - startedAt;
    if (waited >= timing.limitMilliseconds)
      throw new Error("review-not-received");
    if (!triggered && waited >= timing.triggerMilliseconds) {
      triggered = true;
      await operation.calls
        .gh(["pr", "comment", String(pull.number), "--body", triggerText])
        .catch(() => undefined);
    }
    await delay(timing.pollMilliseconds, undefined, {
      signal: operation.signal,
    });
  }
}

export type Method = (operation: Operation) => Promise<unknown>;

export const methods: ReadonlyMap<string, Method> = new Map([
  ["prepare", prepare],
  ["create-issue", createIssue],
  ["discard", discard],
  ["open-pr", openPull],
  ["wait-review", waitReview],
  [
    "merge",
    (operation) =>
      merge(operation, {
        number: integer(operation, "number"),
        commit: text(operation, "commit"),
      }),
  ],
]);
