import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { AnswerTask } from "./input.ts";
import { resultValue, type AnswerTree } from "./threads.ts";
import type { AnswerReport } from "./turn.ts";

export interface PushedPull {
  readonly number: number;
  readonly commit: string;
  readonly target: string;
}

export interface AnswerState {
  readonly task: AnswerTask;
  readonly tree: AnswerTree;
  readonly report: AnswerReport;
  readonly pushed: PushedPull | null;
}

export async function pushAnswers(request: {
  readonly task: AnswerTask;
  readonly tree: AnswerTree;
  readonly report: AnswerReport;
}): Promise<PushedPull | null> {
  const { task, tree, report } = request;
  if (report.commit === null) return null;
  const number = String(task.pullRequest);
  const value = resultValue(
    await protectedEffect({
      scope: { phase: "answer", operation: "github-open-pr", round: 1 },
      capability: "github",
      method: "open-pr",
      target: tree.target,
      payload: JSON.stringify({
        title: `Answer the review of pull request #${number}`,
        body: `Cloving answered the review threads of pull request #${number}.`,
      }),
      units: 1,
    }),
  );
  const { commit } = value;
  if (value["number"] !== task.pullRequest)
    throw new Error("pull-request-changed");
  if (
    typeof commit !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
  )
    throw new Error("invalid-answer-result");
  return { number: task.pullRequest, commit, target: tree.target };
}

export async function askGreptile(request: {
  readonly pushed: PushedPull | null;
}): Promise<string> {
  const { pushed } = request;
  if (pushed === null) return "No push, so no new review.";
  const result = await protectedEffect({
    scope: { phase: "answer", operation: "github-wait-review", round: 1 },
    capability: "github",
    method: "wait-review",
    target: pushed.target,
    payload: JSON.stringify({ number: pushed.number, commit: pushed.commit }),
    units: 1,
  });
  if (result.kind !== "completed")
    return `Greptile review: ${result.reason ?? result.kind}.`;
  return `Greptile review: ${String(resultValue(result)["score"])}/5.`;
}
