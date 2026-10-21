import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureAnalysisSnapshot } from "../src/daemon/chats-capture.ts";
import { records } from "./chats-analysis-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withAnalysis, importId, cycleId } from "./chats-worker-fixture.ts";
import { record } from "../src/protocol.ts";
import { saveAnalysisCheckpoint } from "../src/daemon/chats-checkpoints.ts";
import { batch } from "./chats-analysis-merge-fixture.ts";
import { ref } from "./chats-analysis-fixture.ts";

await test(
  "CLV-158 capture publishes an initial private partial checkpoint and counts-first proposal",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      await fixture.capture();
      const capture = await captureAnalysisSnapshot(fixture.directory, {
        runId: cycleId,
        importId,
      });
      const folder = join(fixture.directory, `capture-${capture.key}`);
      const checkpoint = join(folder, "checkpoint-0.json");
      assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), {
        schemaVersion: 1,
        runId: cycleId,
        importId,
        capturedDigest: capture.digest,
        batchIndex: null,
        status: "partial",
        result: null,
        total: records.length,
        covered: 0,
        uncovered: records.length,
        completedBatchCount: 0,
        nextRecordIndex: 0,
      });
      const proposal = join(folder, "proposal-0.txt");
      assert.match(
        await readFile(proposal, "utf8"),
        /^Status: partial; total 16; covered 0; uncovered 16\.\n/,
      );
      for (const path of [checkpoint, proposal])
        assert.equal((await stat(path)).mode & 0o777, 0o600);
    });
  }),
);

await test(
  "CLV-158 successive committed batches retain cumulative inference and exact partial coverage",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const capture = await captureAnalysisSnapshot(fixture.directory, {
        runId: cycleId,
        importId,
      });
      const folder = join(fixture.directory, `capture-${capture.key}`);
      const first = await saveAnalysisCheckpoint(fixture.directory, {
        capture,
        candidate: batch([ref(1)]),
        batchIndex: 0,
        nextRecordIndex: 4,
        mode: "deliver",
      });
      assert.equal(first.kind, "committed");
      assert.ok("checkpoint" in first);
      assert.equal(first.checkpoint.status, "partial");
      assert.equal(first.checkpoint.covered, 4);
      const firstBytes = await readFile(
        join(folder, "analysis-checkpoint-1.json"),
        "utf8",
      );
      const second = await saveAnalysisCheckpoint(fixture.directory, {
        capture,
        candidate: batch([ref(4)]),
        batchIndex: 1,
        nextRecordIndex: 8,
        mode: "deliver",
      });
      assert.equal(second.kind, "committed");
      assert.ok("checkpoint" in second);
      assert.equal(second.checkpoint.covered, 8);
      assert.equal(second.checkpoint.completedBatchCount, 2);
      assert.deepEqual(second.checkpoint.result.process.stages[0]?.sourceRefs, [
        ref(1),
        ref(4),
      ]);
      for (const checkpoint of [first.checkpoint, second.checkpoint]) {
        assert.equal(checkpoint.covered + checkpoint.uncovered, records.length);
        assert.equal(checkpoint.nextRecordIndex, checkpoint.covered);
        assert.equal(checkpoint.status, "partial");
      }
      assert.equal(
        await readFile(join(folder, "analysis-checkpoint-1.json"), "utf8"),
        firstBytes,
      );
      assert.match(
        await readFile(join(folder, "proposal-checkpoint-2.txt"), "utf8"),
        /^Status: partial; total 16; covered 8; uncovered 8\.\n/,
      );
    });
  }),
);

await test(
  "CLV-158 the single-batch save commits complete coverage and preserves the receipt on replay",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      await fixture.prepare();
      const saved = await fixture.deliver("save-analysis");
      assert.equal(saved.kind, "completed");
      const capture = await captureAnalysisSnapshot(fixture.directory, {
        runId: cycleId,
        importId,
      });
      const folder = join(fixture.directory, `capture-${capture.key}`);
      const path = join(folder, "analysis-checkpoint-1.json");
      const bytes = await readFile(path, "utf8");
      const checkpoint = record(JSON.parse(bytes));
      assert.ok(checkpoint);
      assert.equal(checkpoint["status"], "complete");
      assert.equal(checkpoint["total"], records.length);
      assert.equal(checkpoint["covered"], records.length);
      assert.equal(checkpoint["uncovered"], 0);
      assert.equal(checkpoint["completedBatchCount"], 1);
      assert.equal(checkpoint["nextRecordIndex"], records.length);
      assert.equal(checkpoint["batchIndex"], 0);
      assert.equal(checkpoint["capturedDigest"], capture.digest);
      assert.deepEqual(
        checkpoint["result"],
        JSON.parse(
          await readFile(
            join(fixture.directory, `analysis-${cycleId}.json`),
            "utf8",
          ),
        ),
      );
      const before = await stat(path);
      assert.deepEqual(await fixture.deliver("save-analysis"), saved);
      assert.equal(await readFile(path, "utf8"), bytes);
      assert.equal((await stat(path)).ino, before.ino);
    });
  }),
);
