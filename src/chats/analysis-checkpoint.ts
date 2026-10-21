import type { AnalysisResult } from "./analysis-contract.ts";

export interface AnalysisCheckpoint {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly importId: string;
  readonly capturedDigest: string;
  readonly batchIndex: number | null;
  readonly status: "partial" | "complete";
  readonly result: AnalysisResult | null;
  readonly total: number;
  readonly covered: number;
  readonly uncovered: number;
  readonly completedBatchCount: number;
  readonly nextRecordIndex: number;
}

export interface AnalysisCheckpointCapture {
  readonly runId: string;
  readonly importId: string;
  readonly digest: string;
  readonly totalRecords: number;
}

export function initialAnalysisCheckpoint(
  capture: AnalysisCheckpointCapture,
): AnalysisCheckpoint {
  return {
    schemaVersion: 1,
    runId: capture.runId,
    importId: capture.importId,
    capturedDigest: capture.digest,
    batchIndex: null,
    status: "partial",
    result: null,
    total: capture.totalRecords,
    covered: 0,
    uncovered: capture.totalRecords,
    completedBatchCount: 0,
    nextRecordIndex: 0,
  };
}

export function batchAnalysisCheckpoint(
  capture: AnalysisCheckpointCapture,
  position: {
    readonly batchIndex: number;
    readonly nextRecordIndex: number;
    readonly result: AnalysisResult;
  },
): AnalysisCheckpoint & { readonly result: AnalysisResult } {
  return {
    ...initialAnalysisCheckpoint(capture),
    batchIndex: position.batchIndex,
    status:
      position.nextRecordIndex === capture.totalRecords &&
      position.result.openQuestion === undefined
        ? "complete"
        : "partial",
    result: position.result,
    covered: position.nextRecordIndex,
    uncovered: capture.totalRecords - position.nextRecordIndex,
    completedBatchCount: position.batchIndex + 1,
    nextRecordIndex: position.nextRecordIndex,
  };
}
