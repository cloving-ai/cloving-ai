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

function waitingThread(thread: unknown): boolean {
  return objectOf(thread)["answered"] === false;
}

export function reviewWaiting(result: ProtectedResult): boolean {
  const { threads, quietSeconds } = reviewOf(result);
  return (
    Array.isArray(threads) &&
    threads.some((thread) => waitingThread(thread)) &&
    typeof quietSeconds === "number" &&
    quietSeconds >= 300
  );
}

export interface ReviewPass {
  readonly cycleId: string;
  readonly numbers: readonly number[];
}

export function passOrder(pass: ReviewPass): readonly number[] {
  const { numbers } = pass;
  const sum = Array.from(pass.cycleId).reduce(
    (total, letter) => total + letter.charCodeAt(0),
    0,
  );
  const offset = numbers.length === 0 ? 0 : sum % numbers.length;
  return numbers.slice(offset).concat(numbers.slice(0, offset));
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

export async function answerAt(request: {
  readonly order: readonly number[];
  readonly index: number;
  readonly answered: readonly number[];
}): Promise<readonly number[]> {
  const { answered } = request;
  const number = request.order.at(request.index);
  if (number === undefined) return answered;
  const waiting = await readReview({
    number: number,
    round: request.index + 1,
  });
  if (!waiting || answered.length >= 4) return answered;
  await answerPull({ number: number });
  return answered.concat([number]);
}

export async function answerPulls(
  pass: ReviewPass,
): Promise<readonly number[]> {
  const order = passOrder(pass);
  let answered: readonly number[] = [];
  for (let index = 0; index < 8; index += 1) {
    answered = await answerAt({
      order: order,
      index: index,
      answered: answered,
    });
  }
  return answered;
}
