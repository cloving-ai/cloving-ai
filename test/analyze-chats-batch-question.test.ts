import assert from "node:assert/strict";
import { test } from "node:test";
import { field } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { analysisSource } from "./analyze-chats-sdk-fixture.ts";
import {
  batchSetup,
  inspectBatchCheckpoints,
} from "./analyze-chats-batches-fixture.ts";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";
import { ref } from "./chats-analysis-fixture.ts";
import { ran } from "./develop-workflow-fixture.ts";
import { answeredScenario } from "./analyze-chats-workflow-fixture.ts";
import { batchQuestionSetup } from "./analyze-chats-batch-question-fixture.ts";

await test(
  "CLV-160 batch two pauses with a bound draft before committing its checkpoint",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const result =
        await consumer.run(`${batchSetup({ reply: [batch(), questionBatch()], mode: "planned-replies" })}
const runId = await submitAnalysis();
await until(async () => ["waiting_gate", "completed", "blocked", "failed"].includes(await stateOf(runId)));
${inspectBatchCheckpoints}
await finished(runId);
`);
      assert.equal(result.status, 0, result.stderr);
      const outcome = result.lines[1];
      assert.equal(field(outcome, "state"), "waiting_gate");
      assert.equal(field(outcome, "gates"), 1);
      assert.equal(field(outcome, "drafts"), 1);
      assert.equal(field(outcome, "expiresMatch"), true);
      assert.equal(field(outcome, "candidateBound"), true);
      assert.equal(field(outcome, "turns"), 2);
      assert.deepEqual(field(outcome, "budget"), { limit: 11, spent: 5 });
      assert.deepEqual(field(field(result.lines[0], "checkpoints"), 1), {
        status: "partial",
        covered: 7,
        uncovered: 9,
        completedBatchCount: 1,
        total: 16,
        hasResult: true,
      });
      assert.equal(field(field(result.lines[0], "checkpoints"), "length"), 2);
      assert.equal(field(outcome, "safe"), true);
    }),
  ),
);

for (const position of [0, 2]) {
  await test(
    `CLV-160 an answered question in batch ${String(position + 1)} commits once and completes the run`,
    chatPlatformScenario(() =>
      withConsumer(analysisSource, async (consumer) => {
        const replies = Array.from({ length: 4 }, (_, index) =>
          index === position ? questionBatch() : batch(),
        );
        const result = await consumer.run(`${batchQuestionSetup(replies)}
await answer();
await until(async () => (await stateOf(runId)) === "completed" && (await tagged()).every((run) => run.status === "completed"));
${inspectBatchCheckpoints}
await finished(runId);
`);
        assert.equal(
          result.status,
          0,
          result.stderr + JSON.stringify(result.lines),
        );
        assert.equal(field(field(result.lines[0], "checkpoints"), "length"), 4);
        const outcome = result.lines[1];
        assert.equal(
          field(field(outcome, "outcome"), "kind"),
          "handoff_requested",
        );
        assert.equal(field(outcome, "turns"), 4);
        assert.equal(field(outcome, "gates"), 1);
        assert.deepEqual(field(outcome, "budget"), { limit: 11, spent: 9 });
      }),
    ),
  );
}

await test("CLV-160 a second draft result cannot reuse the decision for a third turn", async () => {
  const given = answeredScenario();
  const draft = given.effects["chats save-analysis"][0];
  const [line] = await ran([
    {
      ...given,
      effectLimit: 11,
      effects: { ...given.effects, "chats save-analysis": [draft, draft] },
    },
  ]);
  assert.equal(
    field(field(line, "outcome"), "reason"),
    "analysis-question-limit",
  );
  assert.equal(field(field(line, "requests"), "length"), 5);
});

await test(
  "CLV-160 one answer follows up the captured second batch and continues the remaining batch",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const result =
        await consumer.run(`${batchSetup({ reply: [batch(), questionBatch(), batch([ref(8)]), batch()], mode: "planned-replies" })}
const runId = await submitAnalysis();
await until(async () => ["waiting_gate", "completed"].includes(await stateOf(runId)));
const [question] = (await asked("questions", { runId })).decisions;
if (!question) throw new Error("analysis-question-not-opened");
writeFileSync(directory + "/redacted.jsonl", "changed after question");
await asked("decision", { command: "answer", reference: question.decisionId, text: "first", expectedRevision: question.revision, generation: question.generation, subjectDigest: question.subjectDigest, commandId: "batch-answer" });
await until(async () => (await tagged()).length === 2 && (await tagged()).every((run) => run.status === "completed"));
const payloads = lines("turns.log").map((line) => JSON.parse(JSON.parse(line).prompt));
const draft = JSON.parse(readFileSync(directory + "/draft-analysis-cycle.json", "utf8"));
print({ captured: JSON.stringify(payloads[1].evidence) === JSON.stringify(payloads[2]?.evidence), context: JSON.stringify(payloads[1].context) === JSON.stringify(payloads[2]?.context), draft: JSON.stringify(JSON.parse(draft.reply)) === JSON.stringify(payloads[2]?.followUp?.draft), answer: payloads[2]?.followUp?.answer, batch: draft.batch });
${inspectBatchCheckpoints}
await finished(runId);
`);
      assert.equal(
        result.status,
        0,
        result.stderr + JSON.stringify(result.lines),
      );
      const followed = result.lines[0];
      for (const key of ["captured", "context", "draft"])
        assert.equal(field(followed, key), true, key);
      assert.equal(field(followed, "answer"), "first");
      assert.equal(field(field(followed, "batch"), "batchIndex"), 1);
      const checkpoints = field(result.lines[1], "checkpoints");
      assert.equal(field(checkpoints, "length"), 4);
      assert.deepEqual(field(checkpoints, 3), {
        status: "complete",
        covered: 16,
        uncovered: 0,
        completedBatchCount: 3,
        total: 16,
        hasResult: true,
      });
      const outcome = result.lines[2];
      assert.equal(
        field(field(outcome, "outcome"), "kind"),
        "handoff_requested",
      );
      assert.deepEqual(field(outcome, "budget"), { limit: 11, spent: 9 });
      assert.equal(field(outcome, "turns"), 4);
      assert.equal(field(outcome, "usageTurns"), 4);
      assert.equal(field(outcome, "safe"), true);
    }),
  ),
);
