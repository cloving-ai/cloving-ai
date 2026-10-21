import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readAnalysisSnapshot,
  readAnalysisCorpus,
} from "../src/daemon/chats-files.ts";
import { prepareAnalysisBatch } from "../src/chats/analysis-batches.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withAnalysis, importId, corpus } from "./chats-worker-fixture.ts";
import {
  captureAnalysisSnapshot,
  readCapturedAnalysisSnapshot,
} from "../src/daemon/chats-capture.ts";
import { readFile, readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { observeAnalysisCorpus } from "./chats-analysis-capture-fixture.ts";

for (const chunkSize of [17, 65_536]) {
  await test(
    `CLV-119 copies corpus during ${String(chunkSize)} byte reads and closes every handle`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const input = corpus.replaceAll(
          "At most",
          "🦊é".repeat(20_000) + "At most",
        );
        await fixture.write("redacted.jsonl", input);
        const observer = observeAnalysisCorpus(chunkSize);
        try {
          const capture = await captureAnalysisSnapshot(fixture.directory, {
            importId,
            runId: "streaming",
          });
          assert.equal(observer.observations.bytes, Buffer.byteLength(input));
          assert.ok(observer.observations.reads.some((writes) => writes > 0));
          assert.ok(
            observer.observations.handles.every((handle) => handle.fd === -1),
          );
          observer.restore();
          const snapshot = await readCapturedAnalysisSnapshot(
            fixture.directory,
            capture,
          );
          assert.equal(snapshot.corpus, input);
        } finally {
          observer.restore();
        }
      });
    }),
  );
}

await test(
  "CLV-119 corpus reads accept the capture cap and stop at the first byte over it",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const path = join(fixture.directory, "redacted.jsonl");
      const handle = await open(path, "w");
      await handle.truncate(52_428_800);
      await handle.close();
      const observer = observeAnalysisCorpus();
      try {
        const exact = await readAnalysisCorpus(path);
        assert.equal(Buffer.byteLength(exact), 52_428_800);
        assert.equal(observer.observations.bytes, 52_428_800);
        const growing = await open(path, "a");
        await growing.truncate(52_428_900);
        await growing.close();
        await assert.rejects(readAnalysisCorpus(path), {
          message: "analysis-too-large",
        });
        assert.equal(observer.observations.bytes, 52_428_800 * 2 + 1);
        assert.ok(
          observer.observations.handles.every((file) => file.fd === -1),
        );
      } finally {
        observer.restore();
      }
    });
  }),
);

await test(
  "CLV-119 privately captures only permitted evidence once and reuses exact bytes after source changes",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const expected = await readAnalysisSnapshot(fixture.directory, {
        importId,
      });
      await fixture.write("corpus.jsonl", "UNREDACTED-SYNTHETIC");
      await fixture.write("revision.json", "UNRELATED-SYNTHETIC");
      const binding = { runId: "synthetic-run", importId };
      const capture = await captureAnalysisSnapshot(fixture.directory, binding);
      assert.equal(capture.totalRecords, 16);
      assert.equal(capture.runId, binding.runId);
      assert.equal(capture.importId, importId);
      assert.match(capture.digest, /^[a-f0-9]{64}$/);
      assert.ok(Buffer.byteLength(JSON.stringify(capture)) <= 65_536);
      const saved = await readCapturedAnalysisSnapshot(
        fixture.directory,
        capture,
      );
      assert.deepEqual(saved, expected);
      await fixture.write("redacted.jsonl", "CHANGED-SYNTHETIC");
      await fixture.write("redaction.json", {});
      await fixture.write("structure.json", {});
      assert.deepEqual(
        await captureAnalysisSnapshot(fixture.directory, binding),
        capture,
      );
      assert.deepEqual(
        await readCapturedAnalysisSnapshot(fixture.directory, capture),
        expected,
      );
      const files = await readdir(fixture.directory, { recursive: true });
      const privateFiles = files.filter(
        (name) => name.includes("capture-") && !name.endsWith(capture.key),
      );
      assert.equal(privateFiles.length, 4);
      for (const name of privateFiles) {
        const path = join(fixture.directory, name);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal(
          (await readFile(path, "utf8")).includes("UNREDACTED-SYNTHETIC"),
          false,
        );
      }
    });
  }),
);

await test(
  "CLV-119 streams a large captured corpus into ordered unsplit batches with exact number tokens",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const input = parseCorpus(corpus)
        .map((message) =>
          JSON.stringify({
            ...message,
            text: "🦊".repeat(2_000),
            blocks: [],
          }).replace(
            '"blocks":[]',
            '"blocks":[{"type":"tool_use","position":0,"id":"call","name":"data","input":{"n":9007199254740993,"d":1.2300,"e":1e400,"z":-0}}]',
          ),
        )
        .join("\r\n");
      assert.ok(Buffer.byteLength(input) > 65_536);
      await fixture.write("redacted.jsonl", input);
      const capture = await captureAnalysisSnapshot(fixture.directory, {
        importId,
        runId: "large-batches",
      });
      const snapshot = await readCapturedAnalysisSnapshot(
        fixture.directory,
        capture,
      );
      assert.equal(snapshot.corpus, input);
      let nextRecordIndex = 0;
      const selected: string[] = [];
      for (
        let completedBatchCount = 0;
        nextRecordIndex < 16;
        completedBatchCount++
      ) {
        const batch = prepareAnalysisBatch(snapshot, {
          nextRecordIndex,
          completedBatchCount,
          previousResult: null,
        });
        assert.ok(batch.kind === "batch");
        assert.ok(batch.launchBytes <= 65_536);
        selected.push(batch.snapshot.corpus);
        nextRecordIndex = batch.nextRecordIndex;
      }
      assert.equal(selected.join(""), input);
      assert.equal(nextRecordIndex, 16);
    });
  }),
);
