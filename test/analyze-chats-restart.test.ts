import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { field } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import {
  analysisSource as source,
  analysisSetup as setup,
  analysisQuestionSetup,
} from "./analyze-chats-sdk-fixture.ts";
import { snapshot } from "./analyze-chats-workflow-fixture.ts";
import { digestOf } from "./service-fixture.ts";

const committedAnswer = `
writeFileSync("hold-analysis-continuation", "");
${analysisQuestionSetup}
await until(async () => (await tagged()).every((run) => run.status === "completed"));
writeFileSync("answer-command.json", JSON.stringify({ command: "answer", reference: question.decisionId, text: "earlier", expectedRevision: question.revision, generation: question.generation, subjectDigest: question.subjectDigest, commandId: "analysis-answer" }));
const response = await answer("earlier");
await until(() => existsSync("hold-analysis-continuation-entered"));
const before = await asked("status", { runId });
writeFileSync("committed-answer.json", JSON.stringify(response));
writeFileSync(directory + "/redacted.jsonl", "changed after answer commit");
await halt("committed-analysis-answer", { runId, recorded: response.kind, budget: before.run.budget, turns: lines("turns.log").length, segments: (await tagged()).length, continuations: lines("analysis-continuations.log").length });
`;

const resumedAnswer = `
import assert from "node:assert/strict";
rmSync("hold-analysis-continuation");
rmSync("draft-question");
${setup}
const runId = process.env.RUN_ID;
const response = await asked("decision", JSON.parse(readFileSync("answer-command.json", "utf8")));
await until(async () => lines("analysis-continuations.log").length > 1 || lines("turns.log").length > 2 || ["completed", "blocked", "failed"].includes(await stateOf(runId)));
assert.equal(lines("analysis-continuations.log").length, 1, "one analysis continuation delivery");
assert.equal(lines("turns.log").length, 2, "two analysis turns across restart");
await until(async () => (await tagged()).every((run) => run.status === "completed"));
const events = (await asked("events", { runId, after: 0, limit: 1000 })).events;
const effects = lines("analysis-effects.log").map((line) => JSON.parse(line));
const turns = lines("turns.log").map((line) => JSON.parse(JSON.parse(line).prompt));
const draft = JSON.parse(readFileSync(directory + "/draft-analysis-cycle.json", "utf8"));
print({ replayed: response.replayed, receiptMatch: JSON.stringify(response.receipt) === JSON.stringify(JSON.parse(readFileSync("committed-answer.json", "utf8")).receipt), continuations: lines("analysis-continuations.log").length, segments: (await tagged()).map((run) => JSON.parse(run.operation)[4]).sort(), reads: effects.filter((effect) => effect.method === "read-analysis").length, finalSaves: effects.filter((effect) => effect.followUp && effect.outcome === "completed").length, savedSnapshots: effects.filter((effect) => effect.method === "save-analysis").map((effect) => effect.snapshotDigest), captured: JSON.stringify(turns[0].evidence) === JSON.stringify(turns[1].evidence), draftMatch: JSON.stringify(turns[1].followUp.draft) === JSON.stringify(JSON.parse(draft.reply)), answer: turns[1].followUp.answer, decisions: events.filter((event) => event.type === "gate.decided").length, completions: events.filter((event) => event.type === "run.completed").length });
await finished(runId);
`;

function assertCompletedRestart(lines: readonly unknown[]): void {
  const resumed = lines[0];
  assert.ok(
    resumed !== null && typeof resumed === "object",
    "Resumed analysis row must be an object.",
  );
  const line = lines[1];
  assert.ok(
    line !== null && typeof line === "object",
    "Completed analysis row must be an object.",
  );
  for (const key of ["replayed", "receiptMatch", "captured", "draftMatch"])
    assert.equal(field(resumed, key), true, key);
  for (const key of [
    "continuations",
    "reads",
    "finalSaves",
    "decisions",
    "completions",
  ])
    assert.equal(field(resumed, key), 1, key);
  assert.deepEqual(field(resumed, "segments"), ["continue-run", "start-run"]);
  assert.deepEqual(field(resumed, "savedSnapshots"), [
    digestOf(JSON.stringify(snapshot)),
    digestOf(JSON.stringify(snapshot)),
  ]);
  assert.equal(field(resumed, "answer"), "earlier");
  assert.equal(field(line, "state"), "completed");
  assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
  assert.deepEqual(field(line, "budget"), { limit: 5, spent: 5 });
  assert.equal(field(line, "gates"), 1);
  assert.equal(field(line, "drafts"), 1);
  assert.equal(field(line, "turns"), 2);
  assert.equal(field(line, "usageTurns"), 2);
  assert.equal(field(line, "safe"), true);
  assert.deepEqual(field(line, "outputs"), [
    "analysis-analysis-cycle.json",
    "proposal-analysis-cycle.txt",
  ]);
}

await test("CLV-150 restart assertions reject non-object rows before reading fields", () => {
  for (const value of [undefined, null, true, 1, "row"]) {
    assert.throws(
      () => {
        assertCompletedRestart([value, {}]);
      },
      { message: "Resumed analysis row must be an object." },
    );
    assert.throws(
      () => {
        assertCompletedRestart([{}, value]);
      },
      { message: "Completed analysis row must be an object." },
    );
  }
});

await test(
  "CLV-150 compiled Local World restart after the answer commits delivers one continuation and saves the original snapshot once",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "committed-analysis-answer",
        committedAnswer,
      );
      const boundary = first.lines[0];
      assert.equal(
        field(boundary, "boundary"),
        "committed-analysis-answer",
        first.stderr,
      );
      assert.equal(field(boundary, "recorded"), "decision-recorded");
      assert.deepEqual(field(boundary, "budget"), { limit: 5, spent: 3 });
      assert.equal(field(boundary, "turns"), 1);
      assert.equal(field(boundary, "segments"), 1);
      assert.equal(field(boundary, "continuations"), 0);
      const second = await consumer.run(resumedAnswer, {
        RUN_ID: String(field(boundary, "runId")),
      });
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      assertCompletedRestart(second.lines);
    }),
  ),
);

await test(
  "CLV-116 compiled Local World replay reuses a durable completed private reply before report delivery and saves once",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "completed-private-result",
        `writeFileSync("halt-before-report", "");${setup}
print({ runId: await submitAnalysis() });
`,
      );
      assert.equal(
        field(first.lines[1], "boundary"),
        "completed-private-result",
        first.stderr,
      );
      const runId = String(field(first.lines[0], "runId"));
      const second = await consumer.run(
        `rmSync("halt-before-report");${setup}
await finished(process.env.RUN_ID);
`,
        { RUN_ID: runId },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      const line = second.lines[0];
      assert.equal(
        field(line, "state"),
        "completed",
        JSON.stringify(second.lines),
      );
      assert.deepEqual(field(line, "budget"), { limit: 5, spent: 3 });
      assert.equal(field(line, "turns"), 1);
      assert.equal(field(line, "usageTurns"), 1);
      assert.equal(field(line, "cost"), 0.25);
      assert.deepEqual(field(line, "usage"), {
        input_tokens: 1500,
        cache_read_input_tokens: 800,
        output_tokens: 150,
      });
      assert.equal(field(line, "safe"), true);
      assert.equal(field(field(line, "outputs"), "length"), 2);
    }),
  ),
);

await test(
  "CLV-116 compiled Local World interruption blocks and never launches a replacement turn",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "interrupted-turn",
        `writeFileSync("interrupt", "");${setup}
const runId = await submitAnalysis();
await until(() => lines("turns.log").length === 1);
const turn = JSON.parse(lines("turns.log")[0]);
process.kill(turn.processId, "SIGKILL");
await until(() => !existsSync("worktrees"));
await halt("interrupted-turn", { runId });
`,
      );
      assert.equal(
        field(first.lines[0], "boundary"),
        "interrupted-turn",
        first.stderr,
      );
      const second = await consumer.run(
        `${setup}
await finished(process.env.RUN_ID);
`,
        { RUN_ID: String(field(first.lines[0], "runId")) },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      assert.equal(field(second.lines[0], "state"), "completed");
      assert.deepEqual(field(second.lines[0], "outcome"), {
        kind: "blocked",
        reason: "analysis-turn-failed",
      });
      assert.equal(field(second.lines[0], "turns"), 1);
      assert.deepEqual(field(second.lines[0], "budget"), {
        limit: 5,
        spent: 2,
      });
      assert.equal(field(field(second.lines[0], "outputs"), "length"), 0);
    }),
  ),
);

await test(
  "CLV-148 compiled Local World recovers a private draft and opens one bound question without finalizing",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "saved-private-draft",
        `writeFileSync("draft-question", ""); writeFileSync("halt-after-draft", "");${setup}
print({ runId: await submitAnalysis() });`,
      );
      const boundary = first.lines[1];
      assert.equal(
        field(boundary, "boundary"),
        "saved-private-draft",
        first.stderr,
      );
      const second = await consumer.run(
        `rmSync("halt-after-draft");${setup}
await finished(process.env.RUN_ID);`,
        { RUN_ID: String(field(first.lines[0], "runId")) },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      const line = second.lines[0];
      assert.equal(field(line, "drafts"), 1);
      assert.equal(field(line, "expiresAt"), field(boundary, "expiresAt"));
      assert.equal(
        field(line, "candidateDigest"),
        field(boundary, "candidateDigest"),
      );
      assert.equal(field(line, "state"), "waiting_gate");
      assert.equal(field(line, "gates"), 1);
      assert.equal(field(line, "expiresMatch"), true);
      assert.equal(field(line, "candidateBound"), true);
      assert.deepEqual(field(line, "budget"), { limit: 5, spent: 3 });
      assert.equal(field(line, "turns"), 1);
      assert.equal(field(line, "usageTurns"), 1);
      assert.equal(field(line, "safe"), true);
      assert.deepEqual(field(line, "outputs"), []);
    }),
  ),
);
