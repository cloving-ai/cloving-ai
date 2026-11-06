import {
  changeCount,
  type ReviewResult,
  type ReviewSubject,
} from "../review-subject.ts";
import { snapshotReviewSubject } from "./review-subject.ts";
import { waitForDecision } from "./wait-for-decision.ts";

export async function reviewByPerson(request: {
  readonly subject: ReviewSubject;
}): Promise<ReviewResult> {
  let draft = "draft" in request.subject ? request.subject.draft : null;
  if (draft !== null && request.subject.commit !== undefined)
    draft = `${request.subject.commit}\n${draft}`;
  const snapshot = await snapshotReviewSubject(request.subject);
  const decision = await waitForDecision({
    gateId: `review:${snapshot.subjectDigest}`,
    kind: "approval",
    prompt: `Review this subject:\n${draft ?? snapshot.prompt}`,
  });
  const accepted = decision.decision === "approved";
  const feedback = decision.answer ?? "";
  return {
    accepted,
    feedback,
    findings: changeCount({ accepted, feedback }),
    commit: snapshot.commit,
    subjectDigest: snapshot.subjectDigest,
  };
}
