export interface AnswerInput {
  readonly cycleId: string;
  readonly repository: string;
  readonly input: { readonly pullRequest: number };
}

export interface AnswerTask {
  readonly cycleId: string;
  readonly repository: string;
  readonly pullRequest: number;
}

export function answerTask(request: AnswerInput): AnswerTask {
  const { pullRequest } = request.input;
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
    throw new Error("invalid-answer-input");
  return {
    cycleId: request.cycleId,
    repository: request.repository,
    pullRequest,
  };
}
