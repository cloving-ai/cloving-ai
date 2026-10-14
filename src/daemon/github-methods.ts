import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  findingsOf,
  scoreOf,
  type CallSettings,
  type Calls,
} from "./github-calls.ts";
import { treePlace, workTree } from "./work-tree.ts";

export interface GithubTiming {
  readonly pollMilliseconds: number;
  readonly triggerMilliseconds: number;
  readonly limitMilliseconds: number;
}

export const githubTiming: GithubTiming = {
  pollMilliseconds: 30_000,
  triggerMilliseconds: 300_000,
  limitMilliseconds: 3_600_000,
};

export interface MethodSettings extends CallSettings {
  readonly worktrees: string;
  readonly timing?: GithubTiming;
  readonly check?: readonly string[];
  readonly privateTexts?: readonly string[];
}

export interface Operation {
  readonly settings: MethodSettings;
  readonly calls: Calls;
  readonly target: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

interface Place {
  readonly path: string;
  readonly branch: string;
}

interface Pull {
  readonly number: number;
  readonly url: string;
}

const repositoryPath = "repos/{owner}/{repo}";
const triggerText = "@greptileai";

export const methodReasons: ReadonlySet<string> = new Set([
  "github-call-failed",
  "git-call-failed",
  "check-failed",
  "invalid-payload",
  "no-change",
  "private-path-in-change",
  "review-not-received",
  "work-tree-not-available",
]);

function text(operation: Operation, name: string): string {
  const value = operation.payload[name];
  if (typeof value !== "string" || value === "")
    throw new Error("invalid-payload");
  return value;
}

function integer(operation: Operation, name: string): number {
  const value = operation.payload[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error("invalid-payload");
  return value;
}

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

async function defaultBranch(operation: Operation): Promise<string> {
  const reference = await operation.calls.git(operation.settings.repository, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  return reference.trim().replace(/^origin[/]/, "");
}

function existingTree(operation: Operation): Place {
  const place = treePlace({
    worktrees: operation.settings.worktrees,
    target: operation.target,
  });
  if (!existsSync(join(place.path, ".git")))
    throw new Error("work-tree-not-available");
  return place;
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
  const privateTexts = operation.settings.privateTexts ?? [homedir()];
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

async function merge(operation: Operation): Promise<unknown> {
  const { settings, calls } = operation;
  const number = integer(operation, "number");
  const commit = text(operation, "commit");
  const tree = existingTree(operation);
  if (settings.check !== undefined) await calls.run(settings.check, tree.path);
  const reply: unknown = JSON.parse(
    await calls.gh([
      "api",
      "-X",
      "PUT",
      `${repositoryPath}/pulls/${String(number)}/merge`,
      "-f",
      "merge_method=merge",
      "-f",
      `sha=${commit}`,
    ]),
  );
  await calls
    .gh([
      "api",
      "-X",
      "DELETE",
      `${repositoryPath}/git/refs/heads/${tree.branch}`,
    ])
    .catch(() => undefined);
  const repository = (parts: readonly string[]): Promise<string> =>
    calls.git(settings.repository, parts);
  await repository(["worktree", "remove", "--force", tree.path]);
  await repository(["branch", "-D", tree.branch]);
  await repository(["update-ref", "-d", `refs/remotes/origin/${tree.branch}`]);
  return { number, merged: String(field(reply, "sha")) };
}

export type Method = (operation: Operation) => Promise<unknown>;

export const methods: ReadonlyMap<string, Method> = new Map([
  ["prepare", prepare],
  ["open-pr", openPull],
  ["wait-review", waitReview],
  ["merge", merge],
]);
