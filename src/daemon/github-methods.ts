import { setTimeout as delay } from "node:timers/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findingsOf,
  scoreOf,
  type Finding,
  type Scored,
} from "./github-calls.ts";
import { attachAsset } from "./github-attach.ts";
import { closeIssue, partialIssue } from "./github-ticket-status.ts";
import { merge } from "./github-merge.ts";
import type { MergeCheck } from "./github-merge-call.ts";
import {
  captureDraft,
  createIssue,
  discard,
  repositoryName,
} from "./github-issue-methods.ts";
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
const maximumReviewRequests = 3;

export const methodReasons: ReadonlySet<string> = new Set([
  "attachment-not-available",
  "attachment-too-large",
  "draft-not-available",
  "draft-changed",
  "draft-too-large",
  "invalid-draft",
  "post-uncertain",
  "private-texts-not-set",
  "github-call-failed",
  "github-network-failed",
  "github-issue-conflict",
  "git-call-failed",
  "check-failed",
  "merge-conflict",
  "check-required",
  "check-not-configured",
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

function mergeCheck(operation: Operation): MergeCheck | undefined {
  if (!Object.hasOwn(operation.payload, "check")) return undefined;
  const value = operation.payload["check"];
  if (value === null || value === "beforeMerge") return value;
  throw new Error("invalid-payload");
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
  const repository =
    !Object.hasOwn(operation.payload, "owner") &&
    !Object.hasOwn(operation.payload, "repository")
      ? repositoryName(
          await operation.calls.gh(["repo", "view", "--json", "nameWithOwner"]),
        )
      : `${text(operation, "owner")}/${text(operation, "repository")}`;
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

export interface ReviewResult extends Scored {
  readonly number: number;
  readonly commit: string;
  readonly findings: readonly Finding[];
}

async function reviewed(
  operation: Operation,
  pull: { readonly number: number; readonly commit: string },
): Promise<ReviewResult | undefined> {
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

interface ReviewFailure {
  readonly call: "read-review" | "request-review";
  readonly reason: "github-call-failed" | "invalid-review-response";
  readonly status?: number;
}

interface ReviewClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const reviewClock: ReviewClock = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  },
};

interface ReviewWait {
  readonly clock: ReviewClock;
  failedReads: number;
  requests: number;
  acceptedRequests: number;
  requestedAt: number;
  lastFailure: ReviewFailure | null;
}

export class ReviewTimeout extends Error {
  readonly detail: string;

  constructor(wait: ReviewWait) {
    super("review-not-received");
    this.detail = JSON.stringify({
      failedReads: wait.failedReads,
      requests: wait.requests,
      acceptedRequests: wait.acceptedRequests,
      lastFailure: wait.lastFailure,
    });
  }
}

async function reviewFailure(
  operation: Operation,
  failed: {
    readonly wait: ReviewWait;
    readonly call: ReviewFailure["call"];
    readonly error: unknown;
  },
): Promise<void> {
  const { wait, call, error } = failed;
  const status = field(error, "status");
  const failure: ReviewFailure = {
    call,
    reason:
      error instanceof SyntaxError
        ? "invalid-review-response"
        : "github-call-failed",
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
      ? { status }
      : {}),
  };
  wait.lastFailure = failure;
  await appendFile(
    join(operation.folder, "review-failures.jsonl"),
    JSON.stringify(failure) + "\n",
    { mode: 0o600 },
  ).catch(() => undefined);
}

async function requestReview(
  operation: Operation,
  request: { readonly wait: ReviewWait; readonly number: number },
): Promise<void> {
  const { wait, number } = request;
  wait.requests++;
  try {
    await operation.calls.gh([
      "pr",
      "comment",
      String(number),
      "--body",
      triggerText,
    ]);
    wait.acceptedRequests++;
    wait.requestedAt = wait.clock.now();
  } catch (error) {
    await reviewFailure(operation, { wait, call: "request-review", error });
  }
}

export async function waitReview(
  operation: Operation,
  clock: ReviewClock = reviewClock,
): Promise<ReviewResult> {
  const pull = {
    number: integer(operation, "number"),
    commit: text(operation, "commit"),
  };
  const timing = operation.settings.timing ?? githubTiming;
  const startedAt = clock.now();
  const wait: ReviewWait = {
    clock,
    failedReads: 0,
    requests: 0,
    acceptedRequests: 0,
    requestedAt: startedAt,
    lastFailure: null,
  };
  for (;;) {
    const review = await reviewed(operation, pull).catch(
      async (error: unknown) => {
        wait.failedReads++;
        await reviewFailure(operation, { wait, call: "read-review", error });
        return undefined;
      },
    );
    if (review !== undefined) return review;
    const waited = clock.now() - startedAt;
    if (waited >= timing.limitMilliseconds) throw new ReviewTimeout(wait);
    if (
      wait.acceptedRequests < maximumReviewRequests &&
      clock.now() - wait.requestedAt >= timing.triggerMilliseconds
    )
      await requestReview(operation, { wait, number: pull.number });
    await clock.sleep(timing.pollMilliseconds, operation.signal);
  }
}

export type Method = (operation: Operation) => Promise<unknown>;

export const methods: ReadonlyMap<string, Method> = new Map([
  ["prepare", prepare],
  ["close-issue", closeIssue],
  ["partial-issue", partialIssue],
  ["label", label],
  ["create-issue", createIssue],
  ["capture-draft", captureDraft],
  ["discard", discard],
  ["open-pr", openPull],
  ["attach-asset", attachAsset],
  ["wait-review", waitReview],
  [
    "merge",
    (operation) =>
      merge(operation, {
        number: integer(operation, "number"),
        commit: text(operation, "commit"),
        check: mergeCheck(operation),
      }),
  ],
]);
