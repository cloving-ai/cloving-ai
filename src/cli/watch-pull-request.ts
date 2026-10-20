import { operationIdentity } from "../operation-identity.ts";
import type {
  WatchPullRequest,
  WatchReview,
  WatchRun,
} from "./watch-render.ts";
import {
  prIdentity,
  type PrIdentity,
  type PrRepository,
} from "./watch-pr-identity.ts";

type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields {
  return typeof value === "object" && value !== null ? { ...value } : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function stamp(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}
function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export interface GithubRecords {
  readonly started: unknown;
  readonly result: unknown;
}

interface GithubResult {
  readonly runId: string;
  readonly round: number;
  readonly method: string;
  readonly completed: boolean;
  readonly attributed: boolean;
  readonly report: Fields;
}

function attributed(started: Fields, operation: readonly unknown[]): boolean {
  const stage = list(operation[5]);
  const checked = operationIdentity({
    round: operation[1],
    run: operation[2],
    phase: operation[3],
    operation: operation[4],
    ...(operation[5] === null
      ? {}
      : { stage: { id: stage[0], visit: stage[1], branch: stage[2] } }),
    ...(operation[6] === null ? {} : { key: operation[6] }),
  });
  return (
    checked.kind === "valid" &&
    checked.value === JSON.stringify(operation) &&
    operation[3] === "pull-request" &&
    operation[4] === `github-${text(started["method"])}` &&
    (started["runId"] === undefined || started["runId"] === operation[2])
  );
}

function githubOf(records: GithubRecords): GithubResult {
  const started = record(records.started);
  const operation = list(parsed(text(started["operationId"])));
  const result = record(records.result);
  const completed = result["outcome"] === "completed";
  return {
    runId: text(operation[2]),
    round: Number(operation[1]),
    method: text(started["method"]),
    completed,
    attributed:
      attributed(started, operation) && !Object.hasOwn(result, "reason"),
    report: completed ? record(parsed(text(result["result"]))) : {},
  };
}

function pullRequestOf(
  results: readonly GithubResult[],
): WatchPullRequest | null {
  const opened = results
    .filter((item) => item.method === "open-pr")
    .map((item) => item.report)
    .findLast((report) => text(report["url"]).startsWith("https://"));
  if (opened === undefined) return null;
  return { number: Number(opened["number"]), url: text(opened["url"]) };
}

function reviewsOf(results: readonly GithubResult[]): WatchReview[] {
  return results
    .filter((item) => item.method === "wait-review")
    .flatMap(({ round, report }) => {
      const score = count(report["score"]);
      if (score === null) return [];
      return [{ round, commit: text(report["commit"]), score }];
    });
}

function mergeCommitOf(results: readonly GithubResult[]): string | null {
  const merged = results
    .filter((item) => item.method === "merge")
    .map((item) => stamp(item.report["merged"]));
  return merged.find((commit) => commit !== null) ?? null;
}

function mergeProofOf(
  results: readonly GithubResult[],
  context: {
    readonly repository: PrRepository | null;
    readonly pullRequest: WatchPullRequest | null;
  },
): PrIdentity | null {
  if (context.repository === null || context.pullRequest === null) return null;
  const repository = context.repository;
  const identity = prIdentity(repository, context.pullRequest);
  if (identity === null) return null;
  const opened = results.filter(
    (item) => item.method === "open-pr" && item.completed && item.attributed,
  );
  if (
    opened.length === 0 ||
    opened.some(
      ({ report }) =>
        report["number"] !== identity.number ||
        typeof report["url"] !== "string" ||
        prIdentity(repository, {
          number: identity.number,
          url: report["url"],
        }) === null,
    )
  )
    return null;
  const merged = results.filter(
    (item) =>
      item.method === "merge" &&
      item.completed &&
      item.attributed &&
      (typeof item.report["reason"] !== "string" ||
        Object.hasOwn(item.report, "merged")),
  );
  if (
    merged.length === 0 ||
    merged.some(
      ({ report }) =>
        report["number"] !== identity.number ||
        typeof report["merged"] !== "string" ||
        report["merged"].trim() === "" ||
        Object.hasOwn(report, "reason"),
    )
  )
    return null;
  return new Set(merged.map(({ report }) => report["merged"])).size === 1
    ? identity
    : null;
}

export function pullOf(
  inputs: {
    readonly records: readonly GithubRecords[];
    readonly repository: PrRepository | null;
  },
  runId: string,
): Pick<WatchRun, "pullRequest" | "reviews" | "mergeCommit" | "mergeProof"> {
  const results = inputs.records
    .map(githubOf)
    .filter((item) => item.runId === runId)
    .toSorted((first, second) => first.round - second.round);
  const pullRequest = pullRequestOf(results);
  const mergeProof = mergeProofOf(results, {
    repository: inputs.repository,
    pullRequest,
  });
  return {
    pullRequest,
    reviews: reviewsOf(results),
    mergeCommit: mergeCommitOf(results),
    ...(mergeProof === null ? {} : { mergeProof }),
  };
}
