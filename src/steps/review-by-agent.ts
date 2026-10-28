import type {
  CommitReviewSubject,
  ReviewResult,
  ReviewSubject,
} from "../review-subject.ts";
import { record } from "../protocol.ts";
import { protectedEffect } from "./protected-effect.ts";
import { snapshotReviewSubject } from "./review-subject.ts";

export async function reviewByAgent(request: {
  readonly subject: ReviewSubject;
  readonly reviewer: { readonly kind: "greptile" };
}): Promise<ReviewResult> {
  if (record(request.reviewer)?.["kind"] !== "greptile")
    throw new Error("invalid-reviewer");
  const subject = { ...request.subject };
  const snapshot = await snapshotReviewSubject(subject);
  if (
    "draft" in subject ||
    !Number.isSafeInteger(subject.number) ||
    Number(subject.number) < 1
  )
    throw new Error("invalid-greptile-subject");
  const effect = await protectedEffect({
    scope: {
      phase: "review",
      operation: "greptile",
      round: 1,
      key: snapshot.subjectDigest,
    },
    capability: "github",
    method: "wait-review",
    target: subject.target,
    payload: JSON.stringify({ number: subject.number, commit: subject.commit }),
    units: 1,
  });
  if (effect.kind !== "completed")
    throw new Error(effect.reason ?? effect.kind);
  const result = greptileResult(effect.result, subject);
  return {
    accepted: result.score === 5,
    feedback: [result.summary, ...result.findings].filter(Boolean).join("\n\n"),
    commit: snapshot.commit,
    subjectDigest: snapshot.subjectDigest,
  };
}

function greptileResult(text: string | null, subject: CommitReviewSubject) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "null");
  } catch {
    throw new Error("invalid-review-result");
  }
  const result = record(parsed);
  if (!result) throw new Error("invalid-review-result");
  const score = result["score"];
  const summary = result["summary"];
  const findings = result["findings"];
  if (
    result["number"] !== subject.number ||
    result["commit"] !== subject.commit ||
    !validScore(score) ||
    typeof summary !== "string" ||
    !Array.isArray(findings)
  )
    throw new Error("invalid-review-result");
  return { score, summary, findings: findings.map(findingText) };
}

function validScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 5
  );
}

function findingText(value: unknown): string {
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
}
