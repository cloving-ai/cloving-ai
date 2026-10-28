import type { ReviewSubject, ReviewResult } from "cloving/workflows";
import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";

export async function acceptWork(
  subject: ReviewSubject,
): Promise<ReviewResult> {
  return await reviewByAgent({
    subject: subject,
    reviewer: { kind: "greptile" },
  });
}
