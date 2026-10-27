import type { ReviewResult, ReviewSubject } from "../review-subject.ts";
import { snapshotReviewSubject } from "./review-subject.ts";
import { waitForDecision } from "./wait-for-decision.ts";

export async function reviewByPerson(request: {
  readonly subject: ReviewSubject;
}): Promise<ReviewResult> {
  const snapshot = await snapshotReviewSubject(request.subject);
  const decision = await waitForDecision({
    gateId: `review:${snapshot.subjectDigest}`,
    kind: "approval",
    prompt: `Review this subject:\n${snapshot.prompt}`,
  });
  return {
    accepted: decision.decision === "approved",
    feedback: decision.answer ?? "",
    commit: snapshot.commit,
    subjectDigest: snapshot.subjectDigest,
  };
}
