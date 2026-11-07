import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { AnswerState } from "./pull.ts";
import type { ThreadAnswer } from "./turn.ts";

export interface ResolveRequest {
  readonly state: AnswerState;
  readonly answer: ThreadAnswer;
  readonly round: number;
}

export async function resolveAfterFix(
  request: ResolveRequest,
): Promise<string> {
  const { state, answer } = request;
  if (!answer.thread.bot || answer.kind !== "fixed")
    return `${answer.thread.label} open`;
  const result = await protectedEffect({
    scope: {
      phase: "answer",
      operation: "github-resolve-thread",
      round: request.round,
    },
    capability: "github",
    method: "resolve-thread",
    target: state.tree.target,
    payload: JSON.stringify({ thread: answer.thread.id }),
    units: 1,
  });
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  return `${answer.thread.label} resolved`;
}

export async function neverResolve(request: ResolveRequest): Promise<string> {
  return await Promise.resolve(`${request.answer.thread.label} open`);
}
