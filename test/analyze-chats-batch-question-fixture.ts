import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";
import { batchSetup } from "./analyze-chats-batches-fixture.ts";

export function batchQuestionSetup(
  replies: readonly unknown[] = [batch(), questionBatch(), batch(), batch()],
): string {
  return `
writeFileSync("clock-analysis", "");
${batchSetup({ reply: replies, mode: "planned-replies" })}
const runId = await submitAnalysis();
await until(async () => ["waiting_gate", "completed"].includes(await stateOf(runId)));
const [question] = (await asked("questions", { runId })).decisions;
if (!question) throw new Error("analysis-question-not-opened");
const answerCommand = { command: "answer", reference: question.decisionId, text: "first", expectedRevision: question.revision, generation: question.generation, subjectDigest: question.subjectDigest, commandId: "batch-answer" };
const answer = (overrides = {}) => asked("decision", { ...answerCommand, ...overrides });
`;
}
