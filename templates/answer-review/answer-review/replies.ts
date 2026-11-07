import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { AnswerState } from "./pull.ts";
import { resolveAfterFix as resolveThread } from "./resolve.ts";
import { threadText, type ThreadAnswer } from "./turn.ts";

export function replyText(answer: ThreadAnswer): string {
  if (answer.kind === "fixed") return `Fixed in ${answer.text}.`;
  return `No change is needed: ${answer.text}`;
}

export async function askPerson(request: {
  readonly state: AnswerState;
  readonly answer: ThreadAnswer;
}): Promise<string | null> {
  const { state, answer } = request;
  const result = await waitForDecision({
    gateId: `answer-review:${state.task.cycleId}:${answer.thread.label}`,
    kind: "question",
    prompt: [
      `A review thread of pull request #${String(state.task.pullRequest)} needs a decision.`,
      `Question: ${answer.text}`,
      threadText(answer.thread),
      "Answer with the text of the reply to post on the thread. Deny the decision to leave the thread without a reply.",
    ].join("\n\n"),
  });
  const text = result.answer?.trim() ?? "";
  return result.decision === "answered" && text !== "" ? text : null;
}

export async function replyBody(request: {
  readonly state: AnswerState;
  readonly answer: ThreadAnswer;
}): Promise<string | null> {
  if (request.answer.kind !== "question") return replyText(request.answer);
  return await askPerson({ state: request.state, answer: request.answer });
}

export async function postReply(request: {
  readonly state: AnswerState;
  readonly answer: ThreadAnswer;
  readonly body: string;
  readonly round: number;
}): Promise<void> {
  const result = await protectedEffect({
    scope: {
      phase: "answer",
      operation: "github-reply-thread",
      round: request.round,
    },
    capability: "github",
    method: "reply-thread",
    target: request.state.tree.target,
    payload: JSON.stringify({
      thread: request.answer.thread.id,
      body: request.body,
    }),
    units: 1,
  });
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
}

export async function answerThread(request: {
  readonly state: AnswerState;
  readonly answer: ThreadAnswer;
  readonly round: number;
}): Promise<string> {
  const { state, answer, round } = request;
  const body = await replyBody({ state: state, answer: answer });
  if (body === null) return `${answer.thread.label} unanswered`;
  await postReply({ state: state, answer: answer, body: body, round: round });
  return await resolveThread({ state: state, answer: answer, round: round });
}

export function replyOrder(state: AnswerState): readonly ThreadAnswer[] {
  const { answers } = state.report;
  return answers
    .filter((answer) => answer.kind !== "question")
    .concat(answers.filter((answer) => answer.kind === "question"));
}

export async function answerAt(request: {
  readonly state: AnswerState;
  readonly answer: ThreadAnswer | undefined;
  readonly round: number;
}): Promise<readonly string[]> {
  const { state, answer, round } = request;
  if (answer === undefined) return [];
  return [await answerThread({ state: state, answer: answer, round: round })];
}

export async function answerThreads(
  state: AnswerState,
): Promise<readonly string[]> {
  const ordered = replyOrder(state);
  let lines: readonly string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const line = await answerAt({
      state: state,
      answer: ordered.at(index),
      round: index + 1,
    });
    lines = lines.concat(line);
  }
  return lines;
}
