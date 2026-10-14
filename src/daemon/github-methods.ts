import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { findingsOf, scoreOf } from "./github-calls.ts";
import { createIssue, discard } from "./github-issue-methods.ts";
import {
  existingTree,
  removeWorktree,
  field,
  githubTiming,
  repositoryPath,
  text,
  type Operation,
  type Place,
  type Pull,
} from "./github-operation.ts";
export type { GithubTiming, MethodSettings } from "./github-operation.ts";
import { treePlace, workTree } from "./work-tree.ts";

const triggerText = "@greptileai";

export const methodReasons: ReadonlySet<string> = new Set([
  "draft-not-available",
  "invalid-draft",
  "post-uncertain",
  "private-texts-not-set",
  "github-call-failed",
  "git-call-failed",
  "check-failed",
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

async function defaultBranch(operation: Operation): Promise<string> {
  const reference = await operation.calls.git(operation.settings.repository, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  return reference.trim().replace(/^origin[/]/, "");
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

async function changeChecked(
  operation: Operation,
  place: { readonly tree: Place; readonly base: string },
): Promise<void> {
  const call = (parts: readonly string[]): Promise<string> =>
    operation.calls.git(place.tree.path, parts);
  const range = `origin/${place.base}..HEAD`;
  if (Number((await call(["rev-list", "--count", range])).trim()) === 0)
    throw new Error("no-change");
  const change = [
    await call(["diff", `origin/${place.base}...HEAD`]),
    await call(["log", "--format=%B", range]),
  ].join("\n");
  const privateTexts = [homedir(), ...(operation.settings.privateTexts ?? [])];
  const lowered = change.toLowerCase();
  if (
    privateTexts.some(
      (item) => item !== "" && lowered.includes(item.toLowerCase()),
    )
  )
    throw new Error("private-path-in-change");
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

async function knownMerge(
  operation: Operation,
  expected: { readonly number: number; readonly commit: string },
): Promise<string | undefined> {
  const pull: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      `${repositoryPath}/pulls/${String(expected.number)}`,
    ]),
  );
  if (field(pull, "merged") !== true) return undefined;
  if (field(field(pull, "head"), "sha") !== expected.commit)
    throw new Error("merged-other-commit");
  return String(field(pull, "merge_commit_sha"));
}

async function mergedNow(
  operation: Operation,
  pull: {
    readonly number: number;
    readonly commit: string;
    readonly tree: Place;
  },
): Promise<string> {
  const { settings, calls } = operation;
  if (settings.check !== undefined)
    await calls.run(settings.check, pull.tree.path);
  const reply: unknown = JSON.parse(
    await calls.gh([
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
  return String(field(reply, "sha"));
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

async function merge(operation: Operation): Promise<unknown> {
  const pull = {
    number: integer(operation, "number"),
    commit: text(operation, "commit"),
  };
  const place = treePlace({
    worktrees: operation.settings.worktrees,
    target: operation.target,
  });
  const merged =
    (await knownMerge(operation, pull)) ??
    (await mergedNow(operation, { ...pull, tree: existingTree(operation) }));
  await removed(operation, place);
  return { number: pull.number, merged };
}

export type Method = (operation: Operation) => Promise<unknown>;

export const methods: ReadonlyMap<string, Method> = new Map([
  ["prepare", prepare],
  ["create-issue", createIssue],
  ["discard", discard],
  ["open-pr", openPull],
  ["wait-review", waitReview],
  ["merge", merge],
]);
