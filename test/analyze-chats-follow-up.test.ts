import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisCommand } from "../src/daemon/analysis-launch.ts";
import { candidate } from "./chats-analysis-fixture.ts";
import { field, ran } from "./develop-workflow-fixture.ts";
import { answeredScenario } from "./analyze-chats-workflow-fixture.ts";
import {
  analysisSource,
  analysisQuestionSetup,
} from "./analyze-chats-sdk-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test(
  "CLV-149 compiled continuation reuses three completed effects and records two restricted turns",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const result = await consumer.run(`${analysisQuestionSetup}
writeFileSync(directory + "/redacted.jsonl", "changed after initial capture");
writeFileSync("turns.log.reply", ${JSON.stringify(JSON.stringify(candidate()))});
const response = await answer("earlier");
await until(async () => (await tagged()).length === 2);
await until(async () => (await tagged()).every((run) => run.status === "completed"));
const turns = lines("turns.log").map((line) => JSON.parse(line));
const payloads = turns.map((turn) => JSON.parse(turn.prompt));
const draft = JSON.parse(readFileSync(directory + "/draft-analysis-cycle.json", "utf8"));
const journals = readdirSync("journal").flatMap((key) => readdirSync("journal/" + key));
print({ recorded: response.kind, arguments: turns.map((turn) => turn.arguments), captured: JSON.stringify(payloads[0].evidence) === JSON.stringify(payloads[1].evidence), draftMatch: JSON.stringify(payloads[1].followUp.draft) === JSON.stringify(JSON.parse(draft.reply)), answer: payloads[1].followUp.answer, journalsSafe: journals.every((name) => !["turn.jsonl", "turn.stderr.log", "working", "configuration"].includes(name)) });
await finished(runId);
`);
      assert.equal(
        result.status,
        0,
        result.stderr + JSON.stringify(result.lines),
      );
      const first = result.lines[0];
      assert.equal(field(first, "recorded"), "decision-recorded");
      assert.deepEqual(field(first, "arguments"), [
        analysisCommand().slice(1),
        analysisCommand().slice(1),
      ]);
      for (const key of ["captured", "draftMatch", "journalsSafe"])
        assert.equal(field(first, key), true);
      assert.equal(field(first, "answer"), "earlier");
      const line = result.lines[1];
      assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
      assert.deepEqual(field(line, "budget"), { limit: 5, spent: 5 });
      assert.equal(field(line, "turns"), 2);
      assert.equal(field(line, "usageTurns"), 2);
      assert.equal(field(line, "cost"), 0.5);
      assert.deepEqual(field(line, "usage"), {
        input_tokens: 3000,
        cache_read_input_tokens: 1600,
        output_tokens: 300,
      });
      assert.equal(field(field(line, "outputs"), "length"), 2);
      assert.equal(field(line, "safe"), true);
    }),
  ),
);

await test("CLV-149 exhausted budgets prevent the next follow-up effect", async () => {
  for (const limit of [3, 4]) {
    const [line] = await ran([{ ...answeredScenario(), effectLimit: limit }]);
    assert.equal(field(field(line, "outcome"), "reason"), "budget-exhausted");
    assert.equal(field(field(line, "requests"), "length"), limit + 1);
    assert.equal(field(line, "spent"), limit);
  }
});

await test("CLV-149 follow-up failures block without accepted output or later turns", async () => {
  for (const [method, reason, count] of [
    ["claude run-turn:analyze-chats", "analysis-turn-failed", 4],
    ["claude run-turn:analyze-chats", "analysis-reply-too-large", 4],
    ["claude run-turn:analyze-chats", "analysis-too-large", 4],
    ["chats save-analysis", "analysis-too-large", 5],
    ["chats save-analysis", "analysis-question-limit", 5],
    ["chats save-analysis", "analysis-follow-up-refused", 5],
  ] as const) {
    const given = answeredScenario();
    const effects = {
      ...given.effects,
      [method]: [
        given.effects[method][0],
        {
          kind: "failed",
          reason,
          result: JSON.stringify({ codes: ["authority-field"] }),
        },
      ],
    };
    const [line] = await ran([{ ...given, effects }]);
    assert.equal(field(field(line, "outcome"), "kind"), "blocked");
    assert.equal(field(field(line, "outcome"), "reason"), reason);
    assert.equal(field(field(line, "requests"), "length"), count);
    assert.equal(
      JSON.stringify(field(line, "outcome")).includes("authority-field"),
      false,
    );
  }
});

for (const [reply, reason] of [
  [
    JSON.stringify({ ...candidate(), authority: "historical permission" }),
    "analysis-follow-up-refused",
  ],
  ["question", "analysis-question-limit"],
] as const) {
  await test(
    `CLV-149 compiled follow-up blocks ${reason} with private validator details`,
    chatPlatformScenario(() =>
      withConsumer(analysisSource, async (consumer) => {
        const result = await consumer.run(`${analysisQuestionSetup}
${reply === "question" ? "" : `writeFileSync("turns.log.reply", ${JSON.stringify(reply)});`}
await answer("earlier");
await until(async () => (await tagged()).length === 2);
await until(async () => (await tagged()).every((run) => run.status === "completed"));
const status = await asked("status", { runId });
const events = await asked("events", { runId, after: 0, limit: 1000 });
print({ validatorPrivate: !JSON.stringify({ status, events }).includes("authority-field") });
await finished(runId);
`);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(field(result.lines[0], "validatorPrivate"), true);
        const line = result.lines[1];
        assert.deepEqual(field(line, "outcome"), { kind: "blocked", reason });
        assert.deepEqual(field(line, "budget"), { limit: 5, spent: 5 });
        assert.equal(field(line, "turns"), 2);
        assert.equal(field(line, "usageTurns"), 2);
        assert.equal(field(line, "safe"), true);
        assert.deepEqual(field(line, "outputs"), []);
      }),
    ),
  );
}
