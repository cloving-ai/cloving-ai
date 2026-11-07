import type { CycleOutcome } from "cloving/workflows";
import {
  answerTask,
  type AnswerInput,
  type AnswerTask,
} from "./answer-review/input.ts";
import {
  prepareAnswer,
  readThreads,
  recordAnswer,
} from "./answer-review/threads.ts";
import { answerTurn } from "./answer-review/turn.ts";
import { askGreptile, pushAnswers } from "./answer-review/pull.ts";
import { answerThreads } from "./answer-review/replies.ts";

function answered(task: AnswerTask, report: string): CycleOutcome {
  return {
    kind: "handoff_requested",
    cycleId: task.cycleId,
    promotionId: `pull-request-${String(task.pullRequest)}`,
    report: report,
  };
}

function failureReason(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
    ? error.message
    : "answer-failed";
}

export async function answerReview(
  request: AnswerInput,
): Promise<CycleOutcome> {
  "use workflow";
  try {
    const task = answerTask(request);
    const tree = await prepareAnswer(task);
    const review = await readThreads({ task: task, tree: tree });
    if (review.threads.length === 0)
      return answered(task, "No open review threads.");
    await recordAnswer({ task: task, tree: tree, review: review });
    const report = await answerTurn({ task: task, tree: tree, review: review });
    const pushed = await pushAnswers({
      task: task,
      tree: tree,
      report: report,
    });
    const lines = await answerThreads({
      task: task,
      tree: tree,
      report: report,
      pushed: pushed,
    });
    const greptile = await askGreptile({ pushed: pushed });
    return answered(task, `Threads: ${lines.join(", ")}. ${greptile}`);
  } catch (error) {
    return {
      kind: "blocked",
      cycleId: request.cycleId,
      reason: failureReason(error),
      evidenceId: "answer",
    };
  }
}
