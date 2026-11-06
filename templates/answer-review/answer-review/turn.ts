import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { AnswerTask } from "./input.ts";
import {
  resultValue,
  type AnswerTree,
  type OpenReview,
  type OpenThread,
  type ThreadComment,
} from "./threads.ts";

export interface ThreadAnswer {
  readonly thread: OpenThread;
  readonly kind: string;
  readonly text: string;
}

interface AnswerLine {
  readonly kind: string;
  readonly text: string;
}

export interface AnswerReport {
  readonly answers: readonly ThreadAnswer[];
  readonly commit: string | null;
}

export interface TurnRequest {
  readonly task: AnswerTask;
  readonly tree: AnswerTree;
  readonly review: OpenReview;
}

const answerLine = /^Thread (T[1-9]\d?): (fixed|no change|question) (\S.*)$/;

function invalid(): never {
  throw new Error("invalid-answer-report");
}

function commentText(comment: ThreadComment): string {
  return `${comment.author}: ${comment.body}`;
}

export function threadText(thread: OpenThread): string {
  const place =
    thread.line === null
      ? thread.path
      : `${thread.path} line ${String(thread.line)}`;
  const marks = [thread.bot ? "bot" : "person"]
    .concat(thread.outdated ? ["outdated"] : [])
    .join(", ");
  return [`Thread ${thread.label} on ${place} (${marks}):`]
    .concat(thread.comments.map((comment) => commentText(comment)))
    .join("\n");
}

export function answerPrompt(request: TurnRequest): string {
  const { task, tree, review } = request;
  const comments =
    review.comments.length === 0
      ? []
      : ["", "Comments of people since the last commit:"].concat(
          review.comments.map((comment) => commentText(comment)),
        );
  return [
    `Answer the open review threads of pull request #${String(task.pullRequest)} in this worktree, on its current branch.`,
    `The main checkout at ${task.repository} is read-only.`,
    "Read AGENTS.md and CLAUDE.md.",
    `Read the change of the pull request with git diff origin/${tree.base}...HEAD.`,
    "For each thread below, fix what the comment asks for, or explain why no change is needed. Ask a question only when a person must decide.",
    "Use TDD for each fix: observe the intended test failure before you change a behavior.",
    "Run the repository checks, commit the fixes, then run npm run check:clean if the repository provides it.",
    "Do not push, publish, deploy, or switch branches. Do not change the pull request or reply to a thread with gh. Cloving pushes the commits and posts one reply to each thread.",
    "The branch is a public pull request. Keep local paths out of tracked files, commit messages and the thread lines.",
    "End the report with one line for each thread, in one of these forms:",
    "Thread T1: fixed <short SHA of the commit with the fix>",
    "Thread T1: no change <reason>",
    "Thread T1: question <question for a person>",
    "",
    "Threads:",
    "",
    review.threads.map((thread) => threadText(thread)).join("\n\n"),
  ]
    .concat(comments)
    .join("\n");
}

function linesOf(summary: string): Map<string, AnswerLine> {
  const found = new Map<string, AnswerLine>();
  for (const line of summary.split("\n")) {
    const match = answerLine.exec(line.trim());
    if (match !== null && !found.has(String(match.at(1))))
      found.set(String(match.at(1)), {
        kind: String(match.at(2)),
        text: String(match.at(3)).trim(),
      });
  }
  return found;
}

function sameCommit(entry: unknown, text: string): boolean {
  const short = String(entry).split(" ", 1).join("");
  return /^[0-9a-f]{7,64}$/.test(short) && text.startsWith(short);
}

function fixedIn(commits: readonly unknown[], text: string): boolean {
  return (
    /^[0-9a-f]{7,64}$/.test(text) &&
    commits.some(
      (entry) => sameCommit(entry, text) || String(entry).startsWith(text),
    )
  );
}

export function answersOf(request: {
  readonly review: OpenReview;
  readonly tree: AnswerTree;
  readonly value: Record<string, unknown>;
}): AnswerReport {
  const { summary, commit, commits } = request.value;
  if (typeof summary !== "string" || !Array.isArray(commits)) invalid();
  const changed = typeof commit === "string" && commit !== request.tree.head;
  const found = linesOf(summary);
  const answers = request.review.threads.flatMap((thread) => {
    const line = found.get(thread.label);
    return line === undefined
      ? []
      : [{ thread, kind: line.kind, text: line.text }];
  });
  if (
    answers.length === 0 ||
    answers.some(
      (answer) =>
        answer.kind === "fixed" && !(changed && fixedIn(commits, answer.text)),
    )
  )
    invalid();
  return { answers, commit: changed ? commit : null };
}

export async function answerTurn(request: TurnRequest): Promise<AnswerReport> {
  const value = resultValue(
    await protectedEffect({
      scope: { phase: "answer", operation: "claude-turn", round: 1 },
      capability: "claude",
      method: "run-turn",
      target: request.tree.target,
      payload: answerPrompt(request),
      units: 1,
    }),
  );
  return answersOf({ review: request.review, tree: request.tree, value });
}
