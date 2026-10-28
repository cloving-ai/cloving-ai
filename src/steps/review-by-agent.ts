import type {
  CommitReviewSubject,
  ReviewResult,
  ReviewSubject,
  ReviewSnapshot,
  Reviewer,
} from "../review-subject.ts";
import { record } from "../protocol.ts";
import { protectedEffect } from "./protected-effect.ts";
import { snapshotReviewSubject } from "./review-subject.ts";

export async function reviewByAgent(request: {
  readonly subject: ReviewSubject;
  readonly reviewer: Reviewer;
}): Promise<ReviewResult> {
  const reviewer = selectedReviewer(request.reviewer);
  const subject = { ...request.subject };
  const snapshot = await snapshotReviewSubject(subject);
  const effect = await protectedEffect({
    ...reviewEffect({ subject, snapshot, reviewer }),
    scope: {
      phase: "review",
      operation:
        reviewer.kind === "greptile" ? "greptile" : `turn:${reviewer.profile}`,
      round: 1,
      key: snapshot.subjectDigest,
    },
    units: 1,
  });
  if (effect.kind !== "completed")
    throw new Error(effect.reason ?? effect.kind);
  let parsed: unknown;
  try {
    parsed = JSON.parse(effect.result ?? "null");
  } catch {
    throw new Error("invalid-review-result");
  }
  return {
    ...(reviewer.kind === "turn"
      ? turnResult(parsed)
      : greptileFeedback(parsed, subject)),
    commit: snapshot.commit,
    subjectDigest: snapshot.subjectDigest,
  };
}

function selectedReviewer(value: unknown): Reviewer {
  const reviewer = record(value);
  if (reviewer?.["kind"] === "greptile") return { kind: "greptile" };
  if (
    reviewer?.["kind"] === "turn" &&
    typeof reviewer["profile"] === "string" &&
    /^[A-Za-z0-9_-]{1,119}$/.test(reviewer["profile"])
  )
    return { kind: "turn", profile: reviewer["profile"] };
  throw new Error("invalid-reviewer");
}

function reviewEffect(input: {
  readonly subject: ReviewSubject;
  readonly snapshot: ReviewSnapshot;
  readonly reviewer: Reviewer;
}) {
  const { subject, snapshot, reviewer } = input;
  if (reviewer.kind === "turn")
    return {
      capability: "claude",
      method: `run-turn:${reviewer.profile}`,
      target: "draft" in subject ? snapshot.subjectDigest : subject.target,
      payload: `Review only this immutable subject. Do not change it. For a commit, inspect that exact commit, not the current branch head.\n${snapshot.prompt}\nEnd your report with exactly one of these lines:\nReview verdict: accept\nReview verdict: change`,
    };
  if (
    "draft" in subject ||
    !Number.isSafeInteger(subject.number) ||
    Number(subject.number) < 1
  )
    throw new Error("invalid-greptile-subject");
  return {
    capability: "github",
    method: "wait-review",
    target: subject.target,
    payload: JSON.stringify({ number: subject.number, commit: subject.commit }),
  };
}

function turnResult(parsed: unknown) {
  const result = record(parsed);
  if (
    result &&
    (result["reviewVerdict"] === null || result["reviewVerdict"] === undefined)
  )
    return {
      accepted: false,
      feedback: "The review turn has no verdict line.",
    };
  if (
    !result ||
    typeof result["summary"] !== "string" ||
    (result["reviewVerdict"] !== "accept" &&
      result["reviewVerdict"] !== "change")
  )
    throw new Error("invalid-review-result");
  return {
    accepted: result["reviewVerdict"] === "accept",
    feedback: result["summary"],
  };
}

function greptileFeedback(parsed: unknown, subject: ReviewSubject) {
  if ("draft" in subject) throw new Error("invalid-greptile-subject");
  const result = greptileResult(parsed, subject);
  return {
    accepted: result.score === 5,
    feedback: [result.summary, ...result.findings].filter(Boolean).join("\n\n"),
  };
}

function greptileResult(parsed: unknown, subject: CommitReviewSubject) {
  const result = record(parsed);
  if (!result) throw new Error("invalid-review-result");
  const score = result["score"];
  const summary = result["summary"];
  const findings = result["findings"];
  if (
    result["number"] !== subject.number ||
    result["commit"] !== subject.commit ||
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 5 ||
    typeof summary !== "string" ||
    !Array.isArray(findings)
  )
    throw new Error("invalid-review-result");
  return {
    score,
    summary,
    findings: findings.map((value: unknown) => {
      const finding = record(value);
      if (!finding) throw new Error("invalid-review-result");
      const { path, line, body } = finding;
      if (
        typeof path !== "string" ||
        typeof body !== "string" ||
        !(
          line === null ||
          (typeof line === "number" && Number.isSafeInteger(line) && line > 0)
        )
      )
        throw new Error("invalid-review-result");
      return `${path}${line === null ? "" : `:${String(line)}`}\n${body}`;
    }),
  };
}
