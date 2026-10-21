import { join } from "node:path";
import { record } from "../protocol.ts";
import {
  initialAnalysisCheckpoint,
  batchAnalysisCheckpoint,
} from "../chats/analysis-checkpoint.ts";
import {
  analysisEvidence,
  type AnalysisSnapshot,
} from "../chats/analysis-input.ts";
import { mergeAnalysisBatch } from "../chats/analysis-merge.ts";
import { prepareAnalysisBatch } from "../chats/analysis-batches.ts";
import { checkpointProposal } from "../chats/analysis-proposal.ts";
import {
  findAnalysisCapture,
  readCapturedAnalysisSnapshot,
  type AnalysisCapture,
} from "./chats-capture.ts";
import { boundedAnalysisFile, inspectAnalysisFiles } from "./chats-files.ts";

interface AnalysisBatchBindingInput {
  readonly runId: string;
  readonly importId: string;
  readonly snapshot: AnalysisSnapshot | undefined;
  readonly batch?: unknown;
}

export async function boundAnalysisBatch(
  directory: string,
  input: AnalysisBatchBindingInput,
) {
  const capture = await findAnalysisCapture(directory, {
    runId: input.runId,
    importId: input.importId,
  });
  if (capture === undefined) throw new Error("analysis-output-failed");
  const snapshot = await readCapturedAnalysisSnapshot(directory, capture);
  const binding = record(input.batch);
  const batchIndex = binding?.["batchIndex"] ?? 0;
  if (typeof batchIndex !== "number") throw new Error("analysis-output-failed");
  const previous = await previousCheckpoint(
    join(directory, `capture-${capture.key}`),
    {
      capture,
      batchIndex,
      snapshot,
    },
  );
  const prepared = prepareAnalysisBatch(snapshot, {
    nextRecordIndex: previous.nextRecordIndex,
    completedBatchCount: previous.completedBatchCount,
    previousResult: previous.result,
  });
  if (prepared.kind === "refused") throw new Error("analysis-output-failed");
  if (
    input.snapshot !== undefined &&
    JSON.stringify(input.batch === undefined ? snapshot : prepared.snapshot) !==
      JSON.stringify(input.snapshot)
  )
    throw new Error("analysis-output-failed");
  if (
    !matchingBatchBinding(input.batch, {
      capturedDigest: capture.digest,
      batchIndex,
      nextRecordIndex: prepared.nextRecordIndex,
      totalRecords: capture.totalRecords,
    })
  )
    throw new Error("analysis-output-failed");
  return {
    capture,
    snapshot,
    batch: { batchIndex, nextRecordIndex: prepared.nextRecordIndex },
    previous,
  };
}

function matchingBatchBinding(
  binding: unknown,
  expected: {
    readonly capturedDigest: string;
    readonly batchIndex: number;
    readonly nextRecordIndex: number;
    readonly totalRecords: number;
  },
): boolean {
  if (binding === undefined)
    return expected.nextRecordIndex === expected.totalRecords;
  const fields = record(binding);
  return ["capturedDigest", "batchIndex", "nextRecordIndex"].every(
    (name) => fields?.[name] === Reflect.get(expected, name),
  );
}

export async function previousCheckpoint(
  folder: string,
  input: {
    readonly capture: AnalysisCapture;
    readonly batchIndex: number;
    readonly snapshot: AnalysisSnapshot;
  },
) {
  const { capture, batchIndex } = input;
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex > 3)
    throw new Error("analysis-input-refused");
  const initial = initialAnalysisCheckpoint(capture);
  if (batchIndex === 0) return initial;
  const name = `analysis-checkpoint-${String(batchIndex)}.json`;
  const text = await boundedAnalysisFile(join(folder, name), {
    permissions: 0o600,
  });
  const checkpoint = restoreCheckpoint(text, input);
  await inspectAnalysisFiles(folder, {
    cycleId: `checkpoint-${String(batchIndex)}`,
    analysis: JSON.stringify(checkpoint) + "\n",
    proposal: checkpointProposal(checkpoint),
  });
  return checkpoint;
}

function restoreCheckpoint(
  text: string,
  input: {
    readonly capture: AnalysisCapture;
    readonly batchIndex: number;
    readonly snapshot: AnalysisSnapshot;
  },
) {
  const value = record(JSON.parse(text));
  const result = record(value?.["result"]);
  const nextRecordIndex = value?.["nextRecordIndex"];
  if (result === undefined || typeof nextRecordIndex !== "number")
    throw new Error("analysis-output-failed");
  const merged = mergeAnalysisBatch({
    previousResult: null,
    candidate: Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== "limitations"),
    ),
    evidence: analysisEvidence(input.snapshot),
    nextRecordIndex,
  });
  if (!merged.accepted) throw new Error("analysis-output-failed");
  const checkpoint = batchAnalysisCheckpoint(input.capture, {
    batchIndex: input.batchIndex - 1,
    nextRecordIndex,
    result: merged.result,
  });
  if (text !== JSON.stringify(checkpoint) + "\n")
    throw new Error("analysis-output-failed");
  return checkpoint;
}
