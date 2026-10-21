import assert from "node:assert/strict";
import { prepareAnalysisBatch } from "../src/chats/analysis-batches.ts";
import type { AnalysisSnapshot } from "../src/chats/analysis-input.ts";
import { emptyCounts } from "../src/chats/redaction.ts";
import { structureImport } from "../src/chats/structure.ts";
import { originalRecords } from "./chats-analysis-fixture.ts";

export function batchSnapshot(texts: readonly string[]) {
  const importId = "11111111-1111-4111-8111-111111111111";
  const records = texts.map((text, index) => ({
    ...originalRecords[0],
    schemaVersion: 2 as const,
    sourceId: `synthetic:${String(index)}`,
    uuid: `message-${String(index)}`,
    role: "user" as const,
    sessionId: null,
    isSidechain: null,
    timestamp: null,
    text,
    blocks: [],
  }));
  return {
    importId,
    redaction: JSON.stringify({
      schemaVersion: 1,
      ruleVersion: 1,
      importId,
      recordCount: records.length,
      counts: emptyCounts(),
      totalCount: 0,
    }),
    corpus: records.map((record) => JSON.stringify(record) + "\n").join(""),
    structure: JSON.stringify({
      schemaVersion: 1,
      importId,
      ...structureImport(records),
    }),
  };
}

export function firstAnalysisBatch(snapshot: AnalysisSnapshot) {
  const batch = prepareAnalysisBatch(snapshot, {
    nextRecordIndex: 0,
    completedBatchCount: 0,
    previousResult: null,
  });
  assert.ok(batch.kind === "batch");
  assert.equal(batch.nextRecordIndex, batch.totalRecords);
  return batch;
}
