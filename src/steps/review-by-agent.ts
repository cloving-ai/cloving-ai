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
  let parsed: unknown;
  try {
    parsed = JSON.parse(effect.result ?? "null");
  } catch {
    throw new Error("invalid-review-result");
  }
  const result = greptileResult(parsed, subject);
  return {
    accepted: result.score === 5,
    feedback: [result.summary, ...result.findings].filter(Boolean).join("\n\n"),
    commit: snapshot.commit,
    subjectDigest: snapshot.subjectDigest,
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
