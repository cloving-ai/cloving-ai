import { operationDigest } from "../broker/operation-digest.ts";
import {
  reviewSubjectText,
  type ReviewSubject,
  type ReviewSnapshot,
} from "../review-subject.ts";

export async function snapshotReviewSubject(
  subject: ReviewSubject,
): Promise<ReviewSnapshot> {
  "use step";
  const prompt = reviewSubjectText(subject);
  return Promise.resolve({
    commit: "draft" in subject ? null : subject.commit,
    subjectDigest: `sha256:${operationDigest(prompt)}`,
    prompt,
  });
}
