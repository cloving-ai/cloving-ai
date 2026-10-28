import { record } from "./protocol.ts";

export interface CommitReviewSubject {
  readonly commit: string;
  readonly target: string;
  readonly number?: number;
}

export interface DraftReviewSubject {
  readonly draft: string;
  readonly commit?: string;
}

export type ReviewSubject = CommitReviewSubject | DraftReviewSubject;

export type Reviewer =
  | { readonly kind: "greptile" }
  | { readonly kind: "turn"; readonly profile: string };

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
  const identity = [
    "cloving-review-subject",
    1,
    "commit",
    subject.target,
    subject.commit,
  ];
  if (subject.number !== undefined) identity.push(subject.number);
  return JSON.stringify(identity);
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

export interface ReviewSnapshot {
  readonly commit: string | null;
  readonly subjectDigest: string;
  readonly prompt: string;
}

export type ReviewVerdict = "accept" | "change";

export function reviewReport(text: string): {
  readonly reviewVerdict: ReviewVerdict | null;
  readonly feedback: string;
} {
  const trimmed = text.trimEnd();
  const start = trimmed.lastIndexOf("\n") + 1;
  const line = trimmed.slice(start);
  const verdict = line.slice("Review verdict: ".length);
  if (
    !line.startsWith("Review verdict: ") ||
    (verdict !== "accept" && verdict !== "change")
  )
    return { reviewVerdict: null, feedback: text };
  return {
    reviewVerdict: verdict,
    feedback: trimmed.slice(0, start).trimEnd(),
  };
}

export function reviewReportStream(limit: number) {
  let text = "";
  let trailing = "";
  let prefix = "";
  let length = 0;
  let contentLength = 0;
  let verdict: ReviewVerdict | null = null;
  const finish = (): void => {
    if (contentLength > 0)
      verdict =
        contentLength > 24
          ? null
          : reviewReport(prefix.slice(0, contentLength)).reviewVerdict;
    prefix = "";
    length = 0;
    contentLength = 0;
  };
  return {
    write: (chunk: string): void => {
      const trimmed = chunk.trimEnd();
      if (trimmed === "") trailing = (trailing + chunk).slice(-limit);
      if (trimmed !== "") {
        text = (text + trailing + trimmed).slice(-limit);
        trailing = chunk.slice(trimmed.length).slice(-limit);
      }
      for (const [index, part] of chunk.split("\n").entries()) {
        if (index > 0) finish();
        if (part.trimEnd() !== "")
          contentLength = Math.min(25, length + part.trimEnd().length);
        prefix = (prefix + part).slice(0, 24);
        length = Math.min(25, length + part.length);
      }
    },
    result: () => {
      finish();
      return { reviewVerdict: verdict, feedback: reviewReport(text).feedback };
    },
  };
}
