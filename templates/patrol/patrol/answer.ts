import type { ProtectedResult } from "cloving/workflows";
import { handoff } from "cloving/workflows/steps/handoff";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function reviewOf(result: ProtectedResult): Record<string, unknown> {
  if (result.kind !== "completed") return {};
  try {
    return objectOf(JSON.parse(result.result ?? "null"));
  } catch {
    return {};
  }
}

function newComments(review: Record<string, unknown>): boolean {
  const latest = objectOf(review["latest"])["id"];
  return typeof latest === "string" && review["answered"] !== latest;
}

export function reviewWaiting(result: ProtectedResult): boolean {
  const review = reviewOf(result);
  const { threads, quietSeconds } = review;
  return (
    Array.isArray(threads) &&
    threads.length > 0 &&
    typeof quietSeconds === "number" &&
    quietSeconds >= 300 &&
    newComments(review)
  );
}

export async function readReview(request: {
  readonly number: number;
  readonly round: number;
}): Promise<boolean> {
  const result = await protectedEffect({
    scope: {
      phase: "patrol",
      operation: "review-threads",
      round: request.round,
    },
    capability: "github",
    method: "review-threads",
    target: "patrol",
    payload: JSON.stringify({ number: request.number }),
    units: 1,
  });
  return reviewWaiting(result);
}

export async function answerPull(request: {
  readonly number: number;
}): Promise<string> {
  return await handoff({
    workflowId: "answer-review",
    input: { pullRequest: request.number },
  });
}

export async function answerPulls(
  numbers: readonly number[],
): Promise<readonly number[]> {
  const answered: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const number = numbers.at(index);
    if (number !== undefined) {
      const waiting = await readReview({ number: number, round: index + 1 });
      if (waiting && answered.length < 4) {
        await answerPull({ number: number });
        answered.push(number);
      }
    }
  }
  return answered;
}
