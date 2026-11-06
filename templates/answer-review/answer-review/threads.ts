import type { ProtectedResult } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { AnswerTask } from "./input.ts";

export const threadLimit = 10;

export interface AnswerTree {
  readonly target: string;
  readonly base: string;
  readonly head: string;
}

export interface ThreadComment {
  readonly author: string;
  readonly body: string;
}

export interface OpenThread {
  readonly label: string;
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly outdated: boolean;
  readonly bot: boolean;
  readonly comments: readonly ThreadComment[];
}

export interface OpenReview {
  readonly threads: readonly OpenThread[];
  readonly comments: readonly ThreadComment[];
  readonly latest: string | null;
}

function invalid(): never {
  throw new Error("invalid-review-threads");
}

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid();
  return Object.fromEntries(Object.entries(value));
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : invalid();
}

function textOf(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : invalid();
}

export function resultValue(result: ProtectedResult): Record<string, unknown> {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  return fields(JSON.parse(result.result ?? "null"));
}

function commentOf(value: unknown): ThreadComment {
  const comment = fields(value);
  return { author: textOf(comment["author"]), body: textOf(comment["body"]) };
}

function threadOf(value: unknown, index: number): OpenThread {
  const thread = fields(value);
  const line = thread["line"];
  return {
    label: `T${String(index + 1)}`,
    id: textOf(thread["id"]),
    path: textOf(thread["path"]),
    line: typeof line === "number" ? line : null,
    outdated: thread["outdated"] === true,
    bot: thread["bot"] === true,
    comments: listOf(thread["comments"]).map((comment) => commentOf(comment)),
  };
}

export function reviewOf(value: Record<string, unknown>): OpenReview {
  const latest = value["latest"];
  return {
    threads: listOf(value["threads"])
      .slice(0, threadLimit)
      .map((thread, index) => threadOf(thread, index)),
    comments: listOf(value["comments"]).map((comment) => commentOf(comment)),
    latest: latest === null ? null : textOf(fields(latest)["id"]),
  };
}

export async function prepareAnswer(task: AnswerTask): Promise<AnswerTree> {
  const value = resultValue(
    await protectedEffect({
      scope: { phase: "answer", operation: "github-prepare", round: 1 },
      capability: "github",
      method: "prepare",
      target: task.cycleId,
      payload: JSON.stringify({ pullRequest: task.pullRequest }),
      units: 1,
    }),
  );
  const { target, base, head } = value;
  if (
    typeof target !== "string" ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(target) ||
    typeof base !== "string" ||
    base.trim() === "" ||
    typeof head !== "string"
  )
    throw new Error("invalid-answer-result");
  return { target, base, head };
}

export async function readThreads(request: {
  readonly task: AnswerTask;
  readonly tree: AnswerTree;
}): Promise<OpenReview> {
  const value = resultValue(
    await protectedEffect({
      scope: { phase: "answer", operation: "github-review-threads", round: 1 },
      capability: "github",
      method: "review-threads",
      target: request.tree.target,
      payload: JSON.stringify({ number: request.task.pullRequest }),
      units: 1,
    }),
  );
  return reviewOf(value);
}

export async function recordAnswer(request: {
  readonly task: AnswerTask;
  readonly tree: AnswerTree;
  readonly review: OpenReview;
}): Promise<void> {
  const result = await protectedEffect({
    scope: { phase: "answer", operation: "github-record-answered", round: 1 },
    capability: "github",
    method: "record-answered",
    target: request.tree.target,
    payload: JSON.stringify({
      number: request.task.pullRequest,
      comment: request.review.latest,
    }),
    units: 1,
  });
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
}
