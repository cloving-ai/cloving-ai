import assert from "node:assert/strict";
import { test } from "node:test";
import { field } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { analysisSource, analysisSetup } from "./analyze-chats-sdk-fixture.ts";
import {
  batchSetup,
  firstCheckpointFiles,
} from "./analyze-chats-batches-fixture.ts";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";

const reopenQuestion = `
rmSync("halt-after-draft");
writeFileSync("hold-analysis-continuation", "");
${analysisSetup}
analysisNow = "2026-10-20T22:00:00.000Z";
const runId = readFileSync("batch-run", "utf8");
await until(async () => (await stateOf(runId)) === "waiting_gate");
await until(async () => (await tagged()).every((run) => run.status === "completed"));
const [question] = (await asked("questions", { runId })).decisions;
const draft = JSON.parse(readFileSync(directory + "/draft-analysis-cycle.json", "utf8"));
const command = { command: "answer", reference: question.decisionId, text: "first", expectedRevision: question.revision, generation: question.generation, subjectDigest: question.subjectDigest, commandId: "batch-answer" };
const unbound = await asked("decision", { ...command, subjectDigest: digestOf("different draft"), commandId: "unbound-batch-answer" });
if (unbound.kind === "decision-recorded") throw new Error("unbound-answer-accepted");
writeFileSync("answer-command.json", JSON.stringify(command));
const response = await asked("decision", command);
writeFileSync("answer-receipt.json", JSON.stringify(response.receipt));
await until(() => existsSync("hold-analysis-continuation-entered"));
await halt("committed-batch-answer", { runId, expiresAt: draft.expiresAt, gateDeadline: question.expiresAt, candidateDigest: draft.candidateDigest, turns: lines("turns.log").length, continuations: lines("analysis-continuations.log").length, segments: (await tagged()).length });
`;

const resumeAnswer = `
rmSync("hold-analysis-continuation");
${analysisSetup}
const runId = process.env.RUN_ID;
const response = await asked("decision", JSON.parse(readFileSync("answer-command.json", "utf8")));
await until(async () => (await stateOf(runId)) === "completed");
await until(async () => (await tagged()).length === 2 && (await tagged()).every((run) => run.status === "completed"));
const folder = directory + "/" + readdirSync(directory).find((name) => name.startsWith("capture-"));
const checkpoints = readdirSync(folder).filter((name) => name.startsWith("analysis-checkpoint-")).sort().map((name) => JSON.parse(readFileSync(folder + "/" + name, "utf8")));
const payloads = lines("turns.log").map((line) => JSON.parse(JSON.parse(line).prompt));
const effects = lines("analysis-effects.log").map((line) => JSON.parse(line));
const events = (await asked("events", { runId, after: 0, limit: 1000 })).events;
print({ replayed: response.replayed, receiptMatch: JSON.stringify(response.receipt) === readFileSync("answer-receipt.json", "utf8"), continuations: lines("analysis-continuations.log").length, followUpSaves: effects.filter((effect) => effect.followUp && effect.outcome === "completed").length, decisions: events.filter((event) => event.type === "gate.decided").length, completions: events.filter((event) => event.type === "run.completed").length, captured: JSON.stringify(payloads[1].evidence) === JSON.stringify(payloads[2].evidence), context: JSON.stringify(payloads[1].context) === JSON.stringify(payloads[2].context), covered: checkpoints.map((checkpoint) => checkpoint.covered), status: checkpoints.at(-1).status });
await finished(runId);
`;

function assertResumedBatch(lines: readonly unknown[]): void {
  for (const key of ["replayed", "receiptMatch", "captured", "context"])
    assert.equal(field(lines[0], key), true, key);
  for (const key of [
    "continuations",
    "followUpSaves",
    "decisions",
    "completions",
  ])
    assert.equal(field(lines[0], key), 1, key);
  assert.deepEqual(field(lines[0], "covered"), [7, 14, 16]);
  assert.equal(field(lines[0], "status"), "complete");
  const outcome = lines[1];
  assert.equal(field(field(outcome, "outcome"), "kind"), "handoff_requested");
  assert.equal(field(outcome, "turns"), 4);
  assert.equal(field(outcome, "usageTurns"), 4);
  assert.equal(field(outcome, "cost"), 1);
  assert.deepEqual(field(outcome, "budget"), { limit: 11, spent: 9 });
  assert.equal(field(outcome, "gates"), 1);
  assert.equal(field(outcome, "drafts"), 1);
  assert.equal(field(outcome, "safe"), true);
}

await test(
  "CLV-160 compiled restart keeps the draft deadline and commits an answered batch once after continuation recovery",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const first = await consumer.runUntil(
        "saved-private-draft",
        `
writeFileSync("clock-analysis", "");
writeFileSync("halt-after-draft", "");
${batchSetup({ reply: [batch(), questionBatch(), batch(), batch()], mode: "planned-replies" })}
writeFileSync("batch-run", await submitAnalysis());
`,
      );
      assert.equal(
        field(first.lines[0], "boundary"),
        "saved-private-draft",
        first.stderr,
      );
      const original = await firstCheckpointFiles(consumer.directory);
      const second = await consumer.runUntil(
        "committed-batch-answer",
        reopenQuestion,
      );
      const boundary = second.lines[0];
      assert.equal(
        field(boundary, "boundary"),
        "committed-batch-answer",
        second.stderr,
      );
      assert.equal(
        field(boundary, "expiresAt"),
        field(first.lines[0], "expiresAt"),
      );
      assert.equal(
        field(boundary, "gateDeadline"),
        field(first.lines[0], "expiresAt"),
      );
      assert.equal(
        field(boundary, "candidateDigest"),
        field(first.lines[0], "candidateDigest"),
      );
      assert.equal(field(boundary, "turns"), 2);
      assert.equal(field(boundary, "continuations"), 0);
      assert.equal(field(boundary, "segments"), 1);
      const third = await consumer.run(resumeAnswer, {
        RUN_ID: String(field(boundary, "runId")),
      });
      assert.equal(third.status, 0, third.stderr + JSON.stringify(third.lines));
      assertResumedBatch(third.lines);
      assert.deepEqual(
        await firstCheckpointFiles(consumer.directory),
        original,
      );
    }),
  ),
);
