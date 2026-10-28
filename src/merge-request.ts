import { record } from "./protocol.ts";
import { commitId } from "./review-subject.ts";

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly commit: string;
  readonly target: string;
}

export type MergeCheckName = "beforeMerge";

export interface MergeRequest {
  readonly pull: PullRequest;
  readonly check: MergeCheckName | null;
}

export type MergeReason =
  | "check-failed"
  | "merge-conflict"
  | "ci-failed"
  | "ci-pending"
  | "check-not-configured"
  | "not-approved";

export interface MergeResult {
  readonly merged: boolean;
  readonly reason: MergeReason | null;
  readonly output: string;
}

export function mergeRequest(value: unknown): MergeRequest {
  const request = record(value);
  const pull = pullRequest(request?.["pull"]);
  const check = request?.["check"];
  if (
    request === undefined ||
    pull === undefined ||
    !Object.hasOwn(request, "check") ||
    (check !== null && check !== "beforeMerge")
  )
    throw new Error("invalid-merge-request");
  return { pull, check };
}

function pullRequest(value: unknown): PullRequest | undefined {
  const pull = record(value);
  const { number, url, commit, target } = pull ?? {};
  if (
    !positiveInteger(number) ||
    typeof url !== "string" ||
    !commitId(commit) ||
    typeof target !== "string" ||
    target.trim() === ""
  )
    return undefined;
  return { number, url, commit, target };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
