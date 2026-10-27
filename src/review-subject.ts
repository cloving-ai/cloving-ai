import { record } from "./protocol.ts";

export interface CommitReviewSubject {
  readonly commit: string;
  readonly target: string;
}

export interface DraftReviewSubject {
  readonly draft: string;
  readonly commit?: string;
}

export type ReviewSubject = CommitReviewSubject | DraftReviewSubject;

export interface ReviewResult {
  readonly accepted: boolean;
  readonly feedback: string;
  readonly commit: string | null;
  readonly subjectDigest: string;
}

export function reviewSubjectText(subject: ReviewSubject): string {
  if (record(subject) === undefined) throw new Error("invalid-review-subject");
  if ("draft" in subject) return draftReviewText(subject);
  if (
    !commitId(subject.commit) ||
    typeof subject.target !== "string" ||
    subject.target.trim() === ""
  )
    throw new Error("invalid-review-subject");
  return JSON.stringify([
    "cloving-review-subject",
    1,
    "commit",
    subject.target,
    subject.commit,
  ]);
}

function draftReviewText(subject: DraftReviewSubject): string {
  if (
    typeof subject.draft !== "string" ||
    subject.draft.trim() === "" ||
    (subject.commit !== undefined && !commitId(subject.commit))
  )
    throw new Error("invalid-review-subject");
  return JSON.stringify([
    "cloving-review-subject",
    1,
    "draft",
    subject.commit ?? null,
    subject.draft,
  ]);
}

function commitId(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}
