import assert from "node:assert/strict";
import { test } from "node:test";
import { field } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { analysisSource } from "./analyze-chats-sdk-fixture.ts";
import { inspectBatchCheckpoints } from "./analyze-chats-batches-fixture.ts";
import { batchQuestionSetup } from "./analyze-chats-batch-question-fixture.ts";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";

const conflict = {
  ...batch(),
  process: { ...batch().process, scope: "A conflicting interpretation." },
};
const stops = [
  {
    name: "expiry",
    script: 'analysisNow = "2026-10-22T10:00:00.000Z";',
    reason: "analysis-answer-missing",
    turns: 2,
    count: 1,
    covered: 7,
  },
  {
    name: "unlisted answer",
    script: 'await answer({ text: " first" });',
    reason: "analysis-answer-invalid",
    turns: 2,
    count: 1,
    covered: 7,
  },
  {
    name: "second question in follow-up",
    reply: questionBatch(),
    reason: "analysis-question-limit",
    turns: 3,
    count: 1,
    covered: 7,
  },
  {
    name: "refused follow-up",
    reply: {},
    reason: "analysis-follow-up-refused",
    turns: 3,
    count: 1,
    covered: 7,
  },
  {
    name: "conflicting follow-up",
    reply: conflict,
    reason: "analysis-merge-conflict",
    turns: 3,
    count: 1,
    covered: 7,
  },
  {
    name: "second question in later batch",
    later: questionBatch(),
    reason: "analysis-question-limit",
    turns: 4,
    count: 2,
    covered: 14,
  },
] as const;

for (const stop of stops) {
  await test(
    `CLV-160 ${stop.name} blocks with the prior accepted result partial`,
    chatPlatformScenario(() =>
      withConsumer(analysisSource, async (consumer) => {
        const replies = [
          batch(),
          questionBatch(),
          "reply" in stop ? stop.reply : batch(),
          "later" in stop ? stop.later : batch(),
        ];
        const result = await consumer.run(`${batchQuestionSetup(replies)}
${"script" in stop ? stop.script : "await answer();"}
await until(async () => (await tagged()).length === 2 && (await tagged()).every((run) => run.status === "completed"));
${inspectBatchCheckpoints}
await finished(runId);
`);
        assert.equal(
          result.status,
          0,
          result.stderr + JSON.stringify(result.lines),
        );
        assert.deepEqual(field(result.lines[1], "outcome"), {
          kind: "blocked",
          reason: stop.reason,
        });
        const checkpoints = field(result.lines[0], "checkpoints");
        assert.equal(field(checkpoints, "length"), stop.count + 1);
        assert.deepEqual(field(checkpoints, stop.count), {
          status: "partial",
          covered: stop.covered,
          uncovered: 16 - stop.covered,
          completedBatchCount: stop.count,
          total: 16,
          hasResult: true,
        });
        const outcome = result.lines[1];
        assert.equal(field(outcome, "gates"), 1);
        assert.equal(field(outcome, "drafts"), 1);
        assert.equal(field(outcome, "turns"), stop.turns);
        assert.equal(field(outcome, "safe"), true);
        assert.deepEqual(field(outcome, "outputs"), []);
      }),
    ),
  );
}
