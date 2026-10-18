import { setTimeout as delay } from "node:timers/promises";
import { findingsOf, scoreOf } from "./github-calls.ts";
import { closeIssue, partialIssue } from "./github-ticket-status.ts";
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
  "head-not-updated",
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

function labels(operation: Operation, name: string): readonly string[] {
  const value = operation.payload[name];
  if (!Array.isArray(value)) throw new Error("invalid-payload");
  return value.map((label: unknown) => {
    if (typeof label !== "string" || label.trim() === "")
      throw new Error("invalid-payload");
    return label;
  });
}

async function label(operation: Operation): Promise<unknown> {
  const repository = `${text(operation, "owner")}/${text(operation, "repository")}`;
  const number = integer(operation, "number");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number))
    throw new Error("invalid-payload");
  const added = labels(operation, "add");
  const removed = labels(operation, "remove");
  for (const name of new Set([...added, ...removed]))
    await operation.calls.gh([
      "label",
      "create",
      name,
      "--repo",
      repository,
      "--color",
      "ededed",
      "--force",
    ]);
  await operation.calls.gh([
    "issue",
    "edit",
    String(number),
    "--repo",
    repository,
    ...added.flatMap((name) => ["--add-label", name]),
    ...removed.flatMap((name) => ["--remove-label", name]),
  ]);
  return { number };
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
  ["close-issue", closeIssue],
  ["partial-issue", partialIssue],
  ["label", label],
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
