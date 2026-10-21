import assert from "node:assert/strict";
import { test } from "node:test";
import {
  scenario,
  snapshot,
  reply,
  input,
  completed,
} from "./analyze-chats-workflow-fixture.ts";
import { importId } from "./chats-worker-fixture.ts";
import { field, ran, request } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { analysisSource } from "./analyze-chats-sdk-fixture.ts";
import {
  batchCorpus,
  batchSetup,
  inspectBatchCheckpoints,
} from "./analyze-chats-batches-fixture.ts";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";

const sizeStop = parseCorpus(batchCorpus())
  .map((message, index) =>
    JSON.stringify(
      index === 7 ? { ...message, text: "x".repeat(70_000) } : message,
    ),
  )
  .join("\n");

for (const { size, count } of [
  { size: 2_000, count: 3 },
  { size: 700, count: 1 },
]) {
  await test(
    `CLV-159 full-size escaped replies save ${String(count)} near-full batches through the capture`,
    chatPlatformScenario(() =>
      withConsumer(analysisSource, async (consumer) => {
        const candidate = batch();
        const reply = {
          ...candidate,
          process: { ...candidate.process, scope: 'quoted"\\\t😀'.repeat(600) },
        };
        const result =
          await consumer.run(`${batchSetup({ reply, corpus: batchCorpus(size) })}
const reply = readFileSync("batch-reply.json", "utf8");
writeFileSync("batch-reply.json", reply + "\\t".repeat(16_000 - Buffer.byteLength(reply)));
installAnalysisCli({ directory: process.cwd() }, { reply: readFileSync("batch-reply.json", "utf8"), mode: "fixed-reply" });
const runId = await submitAnalysis();
await until(async () => ["completed", "blocked", "failed"].includes(await stateOf(runId)));
${inspectBatchCheckpoints}
await finished(runId);
`);
        assert.equal(result.status, 0, result.stderr);
        const outcome = result.lines[1];
        assert.equal(
          field(field(outcome, "outcome"), "kind"),
          "handoff_requested",
          JSON.stringify(result.lines),
        );
        assert.deepEqual(field(outcome, "budget"), {
          limit: 11,
          spent: 1 + count * 2,
        });
        assert.equal(field(outcome, "turns"), count);
        assert.equal(field(outcome, "usageTurns"), count);
        assert.equal(field(outcome, "cost"), count * 0.25);
        const checkpoints = field(result.lines[0], "checkpoints");
        assert.ok(Array.isArray(checkpoints));
        assert.equal(checkpoints.length, count + 1);
        assert.deepEqual(checkpoints.at(-1), {
          status: "complete",
          covered: 16,
          uncovered: 0,
          completedBatchCount: count,
          total: 16,
          hasResult: true,
        });
      }),
    ),
  );
}
const stopCases = [
  {
    name: "merge conflict",
    mode: "conflict-second",
    covered: 7,
    count: 1,
    turns: 2,
    spent: 5,
    reason: "analysis-merge-conflict",
  },
  {
    name: "budget after capture",
    limit: "1",
    covered: 0,
    count: 0,
    turns: 0,
    spent: 1,
    reason: "budget-exhausted",
  },
  {
    name: "budget after one batch",
    limit: "3",
    covered: 7,
    count: 1,
    turns: 1,
    spent: 3,
    reason: "budget-exhausted",
  },
  {
    name: "fifth batch",
    corpus: batchCorpus(4_000),
    covered: 12,
    count: 4,
    turns: 4,
    spent: 9,
    reason: "analysis-batch-limit",
  },
  {
    name: "oversized first record",
    corpus: batchCorpus(20_000),
    covered: 0,
    count: 0,
    turns: 0,
    spent: 1,
    reason: "analysis-too-large",
  },
  {
    name: "oversized later record",
    corpus: sizeStop,
    covered: 7,
    count: 1,
    turns: 1,
    spent: 3,
    reason: "analysis-too-large",
  },
  {
    name: "invalid first reply",
    reply: {},
    covered: 0,
    count: 0,
    turns: 1,
    spent: 3,
    reason: "unknown-version",
  },
  {
    name: "invalid later reply",
    mode: "invalid-second",
    covered: 7,
    count: 1,
    turns: 2,
    spent: 5,
    reason: "unknown-version",
  },
  {
    name: "worker failure",
    mode: "no-result",
    covered: 0,
    count: 0,
    turns: 1,
    spent: 2,
    reason: "analysis-turn-failed",
  },
] as const;

for (const given of stopCases) {
  await test(
    `CLV-159 ${given.name} retains exact partial coverage and a visible proposal`,
    chatPlatformScenario(() =>
      withConsumer(analysisSource, async (consumer) => {
        const result = await consumer.run(
          `${batchSetup({ corpus: "corpus" in given ? given.corpus : batchCorpus(), reply: "reply" in given ? given.reply : undefined, mode: "mode" in given ? given.mode : "fixed-reply" })}
const runId = await submitAnalysis();
await until(async () => ["completed", "blocked", "failed"].includes(await stateOf(runId)));
${inspectBatchCheckpoints}
await finished(runId);
`,
          { ANALYSIS_EFFECT_LIMIT: "limit" in given ? given.limit : "11" },
        );
        assert.equal(
          result.status,
          0,
          result.stderr + JSON.stringify(result.lines),
        );
        const checkpoints = field(result.lines[0], "checkpoints");
        assert.ok(Array.isArray(checkpoints));
        assert.equal(checkpoints.length, given.count + 1);
        const last: unknown = checkpoints.at(-1);
        assert.deepEqual(last, {
          status: "partial",
          covered: given.covered,
          uncovered: 16 - given.covered,
          completedBatchCount: given.count,
          total: 16,
          hasResult: given.count > 0,
        });
        assert.ok(
          String(
            field(field(result.lines[0], "proposals"), given.count),
          ).startsWith(
            `Status: partial; total 16; covered ${String(given.covered)}; uncovered ${String(16 - given.covered)}.`,
          ),
        );
        assert.deepEqual(
          field(result.lines[0], "conflicts"),
          given.name === "merge conflict"
            ? ["conflict-1-incoming.json", "conflict-1.json"]
            : [],
        );
        const outcome = result.lines[1];
        assert.deepEqual(field(outcome, "outcome"), {
          kind: "blocked",
          reason: given.reason,
        });
        assert.deepEqual(field(outcome, "budget"), {
          limit: "limit" in given ? Number(given.limit) : 11,
          spent: given.spent,
        });
        assert.equal(field(outcome, "turns"), given.turns);
        assert.equal(field(outcome, "safe"), true);
        assert.deepEqual(field(outcome, "outputs"), []);
      }),
    ),
  );
}

await test(
  "CLV-160 a question in batch one pauses before accepting a checkpoint",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const result =
        await consumer.run(`${batchSetup({ reply: questionBatch() })}
const runId = await submitAnalysis();
await until(async () => ["completed", "blocked", "failed", "waiting_gate"].includes(await stateOf(runId)));
${inspectBatchCheckpoints}
await finished(runId);
`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(field(result.lines[1], "state"), "waiting_gate");
      assert.equal(field(field(result.lines[0], "checkpoints"), "length"), 1);
      assert.equal(field(result.lines[1], "turns"), 1);
    }),
  ),
);

await test("CLV-159 commits each of three batches before starting the next restricted turn", async () => {
  const given = scenario();
  const batches = [0, 1, 2].map((batchIndex) => ({
    snapshot: { ...snapshot, corpus: `batch-${String(batchIndex)}` },
    context: {
      batchIndex,
      firstRecordIndex: batchIndex,
      previousResult: batchIndex === 0 ? null : { accepted: batchIndex },
    },
    batch: {
      batchIndex,
      nextRecordIndex: batchIndex + 1,
      capturedDigest: "a".repeat(64),
    },
  }));
  const [line] = await ran([
    {
      ...given,
      effectLimit: 11,
      effects: {
        "chats read-analysis": [completed(batches[0])],
        "claude run-turn:analyze-chats": batches.map(() =>
          completed({ reply }),
        ),
        "chats save-analysis": [
          ...batches
            .slice(1)
            .map((batch) => completed({ kind: "analysis_batch", ...batch })),
          ...given.effects["chats save-analysis"],
        ],
      },
    },
  ]);
  assert.equal(field(field(line, "outcome"), "kind"), "handoff_requested");
  assert.equal(field(line, "spent"), 7);
  assert.equal(field(field(line, "requests"), "length"), 7);
  for (const [index, batch] of batches.entries()) {
    const turn = request(line, index * 2 + 1);
    const save = request(line, index * 2 + 2);
    assert.equal(field(field(turn, "scope"), "round"), index + 1);
    assert.equal(field(field(save, "scope"), "round"), index + 1);
    assert.equal(field(turn, "method"), "run-turn:analyze-chats");
    assert.equal(field(save, "method"), "save-analysis");
    assert.deepEqual(JSON.parse(String(field(turn, "payload"))), {
      snapshot: batch.snapshot,
      context: batch.context,
    });
    assert.deepEqual(JSON.parse(String(field(save, "payload"))), {
      importId,
      cycleId: input.cycleId,
      reply,
      batch: batch.batch,
    });
  }
});
