import type { AnalysisResult } from "./analysis-contract.ts";
import {
  analysisDocumentBytes,
  analysisEvidence,
  isAnalysisSnapshot,
  validAnalysisImportId,
  type AnalysisSnapshot,
} from "./analysis-input.ts";
import { analysisLaunchBytes, analysisPrompt } from "./analysis-prompt.ts";
import type { ImportStructure } from "./structure.ts";

export interface AnalysisBatchPosition {
  readonly nextRecordIndex: number;
  readonly completedBatchCount: number;
  readonly previousResult: AnalysisResult | null;
}

export interface AnalysisBatch {
  readonly kind: "batch";
  readonly batchIndex: number;
  readonly firstRecordIndex: number;
  readonly nextRecordIndex: number;
  readonly totalRecords: number;
  readonly snapshot: AnalysisSnapshot;
  readonly prompt: string;
  readonly launchBytes: number;
  readonly adapterDocument: string;
}

export type AnalysisBatchPreparation =
  | AnalysisBatch
  | {
      readonly kind: "refused";
      readonly code:
        | "analysis-input-refused"
        | "analysis-too-large"
        | "analysis-batch-limit";
    };

export const analysisCaptureBytes = 52_428_800;

export function prepareAnalysisBatch(
  snapshot: AnalysisSnapshot,
  position: AnalysisBatchPosition,
): AnalysisBatchPreparation {
  if (
    !isAnalysisSnapshot(snapshot) ||
    !validAnalysisImportId(snapshot.importId)
  )
    return { kind: "refused", code: "analysis-input-refused" };
  if (
    Buffer.byteLength(snapshot.corpus) > analysisCaptureBytes ||
    [snapshot.redaction, snapshot.structure].some(
      (text) => Buffer.byteLength(text) > analysisDocumentBytes,
    )
  )
    return { kind: "refused", code: "analysis-too-large" };
  try {
    return preparedBatch(snapshot, position);
  } catch {
    return { kind: "refused", code: "analysis-input-refused" };
  }
}

function preparedBatch(
  snapshot: AnalysisSnapshot,
  position: AnalysisBatchPosition,
): AnalysisBatchPreparation {
  const lines = snapshot.corpus.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (!validPosition(position, lines.length))
    return { kind: "refused", code: "analysis-input-refused" };
  if (position.completedBatchCount === 4)
    return { kind: "refused", code: "analysis-batch-limit" };
  const structure = analysisEvidence(snapshot).structure;
  let longest: AnalysisBatchPreparation = {
    kind: "refused",
    code: "analysis-too-large",
  };
  for (let end = position.nextRecordIndex + 1; end <= lines.length; end++) {
    const batch = batchOf(snapshot, { lines, position, end, structure });
    if (
      batch.launchBytes > analysisDocumentBytes ||
      Buffer.byteLength(batch.adapterDocument) > analysisDocumentBytes
    )
      break;
    longest = batch;
  }
  return longest;
}

function validPosition(
  position: AnalysisBatchPosition,
  total: number,
): boolean {
  return (
    Number.isSafeInteger(position.nextRecordIndex) &&
    position.nextRecordIndex >= 0 &&
    position.nextRecordIndex < total &&
    Number.isSafeInteger(position.completedBatchCount) &&
    position.completedBatchCount >= 0 &&
    position.completedBatchCount <= 4
  );
}

function batchOf(
  snapshot: AnalysisSnapshot,
  input: {
    readonly lines: readonly string[];
    readonly position: AnalysisBatchPosition;
    readonly end: number;
    readonly structure: ImportStructure;
  },
): AnalysisBatch {
  const { position, lines, end } = input;
  const batchSnapshot = {
    ...snapshot,
    corpus: lines.slice(position.nextRecordIndex, end).join(""),
    structure: projectedStructure(snapshot.importId, input),
  };
  const context = {
    batchIndex: position.completedBatchCount,
    firstRecordIndex: position.nextRecordIndex,
    previousResult: position.previousResult,
  };
  const prompt = analysisPrompt(batchSnapshot, context);
  return {
    kind: "batch",
    batchIndex: context.batchIndex,
    firstRecordIndex: context.firstRecordIndex,
    nextRecordIndex: end,
    totalRecords: lines.length,
    snapshot: batchSnapshot,
    prompt,
    launchBytes: analysisLaunchBytes(prompt),
    adapterDocument: JSON.stringify({ snapshot: batchSnapshot, context }),
  };
}

function projectedStructure(
  importId: string,
  input: {
    readonly position: AnalysisBatchPosition;
    readonly end: number;
    readonly structure: ImportStructure;
  },
): string {
  const { structure, position, end } = input;
  return JSON.stringify({
    schemaVersion: 1,
    importId,
    historyCompleteness: structure.historyCompleteness,
    occurrences: structure.occurrences.slice(position.nextRecordIndex, end),
    conflictGroups: structure.conflictGroups
      .map((group) => ({
        uuid: group.uuid,
        variants: group.variants
          .map((variant) =>
            variant.filter((reference) => reference.recordIndex < end),
          )
          .filter((variant) => variant.length > 0),
      }))
      .filter((group) => group.variants.length > 0),
  });
}
