import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareAnalysisBatch } from "../src/chats/analysis-batches.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { field } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { analysisSource, analysisSetup } from "./analyze-chats-sdk-fixture.ts";
import { snapshot } from "./analyze-chats-workflow-fixture.ts";
import { digestOf } from "./service-fixture.ts";

await test(
  "CLV-119 analyzeChats captures once and launches the prepared single batch",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const batch = prepareAnalysisBatch(snapshot, {
        nextRecordIndex: 0,
        completedBatchCount: 0,
        previousResult: null,
      });
      assert.ok(batch.kind === "batch");
      assert.equal(batch.nextRecordIndex, batch.totalRecords);
      const result = await consumer.run(`${analysisSetup}
writeFileSync("hold-analysis-save", "");
const runId = await submitAnalysis();
await until(() => existsSync("hold-analysis-save-entered"));
rmSync("hold-analysis-save");
await until(() => lines("analysis-effects.log").some((line) => { const effect = JSON.parse(line); return effect.method === "save-analysis" && effect.outcome === "completed"; }));
const captures = readdirSync(directory).filter((name) => name.startsWith("capture-"));
const captured = captures.length === 1 ? directory + "/" + captures[0] : undefined;
const turn = lines("turns.log").map((line) => JSON.parse(line))[0];
print({ captures: captures.length, corpusDigest: captured ? digestOf(readFileSync(captured + "/redacted.jsonl", "utf8")) : null, prompt: turn?.prompt, saves: lines("analysis-effects.log").map((line) => JSON.parse(line)).filter((effect) => effect.method === "save-analysis" && effect.outcome === "completed").length });
await finished(runId);
`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(field(result.lines[0], "captures"), 1);
      assert.equal(
        field(result.lines[0], "corpusDigest"),
        digestOf(snapshot.corpus),
      );
      assert.equal(field(result.lines[0], "prompt"), batch.prompt);
      assert.equal(field(result.lines[0], "saves"), 1);
      assert.equal(field(result.lines[1], "turns"), 1);
      assert.equal(
        field(field(result.lines[1], "outcome"), "kind"),
        "handoff_requested",
      );
    }),
  ),
);

await test(
  "CLV-159 analyzeChats captures a multi-batch import once and retains the initial partial output on invalid inference",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const corpus = parseCorpus(snapshot.corpus)
        .map((message) =>
          JSON.stringify({ ...message, text: "🦊".repeat(2_000) }),
        )
        .join("\n");
      const batch = prepareAnalysisBatch(
        { ...snapshot, corpus },
        {
          nextRecordIndex: 0,
          completedBatchCount: 0,
          previousResult: null,
        },
      );
      assert.ok(batch.kind === "batch");
      assert.ok(batch.nextRecordIndex > 0);
      assert.ok(batch.nextRecordIndex < batch.totalRecords);
      const result = await consumer.run(`${analysisSetup}
writeFileSync(directory + "/redacted.jsonl", ${JSON.stringify(corpus)}, { mode: 0o600 });
const runId = await submitAnalysis();
await finished(runId);
const captures = readdirSync(directory).filter((name) => name.startsWith("capture-"));
print({ captures: captures.length, corpusDigest: captures.length === 1 ? digestOf(readFileSync(directory + "/" + captures[0] + "/redacted.jsonl", "utf8")) : null, effects: lines("analysis-effects.log").map((line) => JSON.parse(line).method) });
`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(field(result.lines[1], "captures"), 1);
      assert.equal(field(result.lines[1], "corpusDigest"), digestOf(corpus));
      assert.deepEqual(
        field(result.lines[1], "effects"),
        ["read-analysis"],
        JSON.stringify(result.lines),
      );
      assert.deepEqual(field(result.lines[0], "outcome"), {
        kind: "blocked",
        reason: "unknown-source",
      });
      assert.equal(field(result.lines[0], "turns"), 1);
      assert.deepEqual(field(result.lines[0], "outputs"), []);
    }),
  ),
);
