import { operationDigest } from "../broker/operation-digest.ts";
import { reviewSubjectText, type ReviewSubject } from "../review-subject.ts";

export async function snapshotReviewSubject(subject: ReviewSubject): Promise<{
  readonly commit: string | null;
  readonly subjectDigest: string;
  readonly prompt: string;
}> {
  "use step";
  const prompt = reviewSubjectText(subject);
  return Promise.resolve({
    commit: "draft" in subject ? null : subject.commit,
    subjectDigest: `sha256:${operationDigest(prompt)}`,
    prompt,
  });
}
