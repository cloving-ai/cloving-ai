import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  initialAnalysisCheckpoint,
  batchAnalysisCheckpoint,
  type AnalysisCheckpoint,
} from "../chats/analysis-checkpoint.ts";
import { record } from "../protocol.ts";
import {
  analysisEvidence,
  analysisDocumentBytes,
  type AnalysisSnapshot,
} from "../chats/analysis-input.ts";
import { mergeAnalysisBatch } from "../chats/analysis-merge.ts";
import {
  prepareAnalysisBatch,
  type AnalysisBatchPreparation,
} from "../chats/analysis-batches.ts";
import {
  analysisProposal,
  checkpointProposal,
} from "../chats/analysis-proposal.ts";
import {
  readCapturedAnalysisSnapshot,
  findAnalysisCapture,
  type AnalysisCapture,
} from "./chats-capture.ts";
import {
  boundedAnalysisFile,
  matchingPrivateFile,
  inspectAnalysisFiles,
  saveAnalysisFiles,
} from "./chats-files.ts";

interface CheckpointInput {
  readonly capture: AnalysisCapture;
  readonly candidate: unknown;
  readonly batchIndex: number;
  readonly nextRecordIndex: number;
  readonly mode: "deliver" | "reconcile";
}

interface FinalizeInput {
  readonly runId: string;
  readonly importId: string;
  readonly cycleId: string;
  readonly snapshot: AnalysisSnapshot | undefined;
  readonly candidate: unknown;
  readonly mode: "deliver" | "reconcile";
  readonly batch?: unknown;
}

export async function finalizeAnalysis(
  directory: string,
  input: FinalizeInput,
): Promise<
  | (Awaited<ReturnType<typeof saveAnalysisCheckpoint>> & {
      readonly next?: AnalysisBatchPreparation | undefined;
    })
  | { readonly kind: "absent" }
> {
  const { capture, batch, snapshot } = await boundBatch(directory, input);
  const inspected = await saveAnalysisCheckpoint(directory, {
    ...batch,
    capture,
    candidate: input.candidate,
    mode: "reconcile",
  });
  if (inspected.kind === "refused") return inspected;
  if (!("checkpoint" in inspected)) {
    if (input.mode === "reconcile") return { kind: "absent" as const };
    return saveAnalysisCheckpoint(directory, {
      ...batch,
      capture,
      candidate: input.candidate,
      mode: "deliver",
    });
  }
  return commitAnalysisBatch(directory, {
    input,
    batch: { ...batch, capture, candidate: input.candidate, mode: input.mode },
    snapshot,
    inspected,
  });
}

interface PreparedCommit {
  readonly input: FinalizeInput;
  readonly batch: CheckpointInput;
  readonly snapshot: AnalysisSnapshot;
  readonly inspected: Awaited<ReturnType<typeof persistCheckpoint>>;
}

async function commitAnalysisBatch(
  directory: string,
  prepared: PreparedCommit,
) {
  const { input, batch, snapshot, inspected } = prepared;
  const output = {
    cycleId: input.cycleId,
    analysis: JSON.stringify(inspected.checkpoint.result) + "\n",
    proposal: analysisProposal(inspected.checkpoint.result),
  };
  const complete = inspected.checkpoint.status === "complete";
  const legacy = complete
    ? await inspectAnalysisFiles(directory, output)
    : "present";
  if (
    input.mode === "reconcile" &&
    (inspected.kind === "absent" || legacy === "absent")
  )
    return { kind: "absent" as const };
  const saved = await saveAnalysisCheckpoint(directory, {
    ...batch,
    mode: input.mode,
  });
  if (saved.kind !== "committed") return saved;
  if (complete && input.mode === "deliver")
    await saveAnalysisFiles(directory, output);
  const next = complete
    ? undefined
    : prepareAnalysisBatch(snapshot, {
        nextRecordIndex: saved.checkpoint.nextRecordIndex,
        completedBatchCount: saved.checkpoint.completedBatchCount,
        previousResult: saved.checkpoint.result,
      });
  return { ...saved, next };
}

async function boundBatch(directory: string, input: FinalizeInput) {
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

export async function saveAnalysisCheckpoint(
  directory: string,
  input: CheckpointInput,
) {
  const { capture, candidate } = input;
  const snapshot = await readCapturedAnalysisSnapshot(directory, capture);
  const folder = join(directory, `capture-${capture.key}`);
  const previous = await previousCheckpoint(folder, { ...input, snapshot });
  if (
    !Number.isSafeInteger(input.nextRecordIndex) ||
    input.nextRecordIndex <= previous.nextRecordIndex ||
    input.nextRecordIndex > capture.totalRecords ||
    previous.status === "complete"
  )
    throw new Error("analysis-input-refused");
  const merged = mergeAnalysisBatch({
    previousResult: previous.result,
    candidate,
    evidence: analysisEvidence(snapshot),
    nextRecordIndex: input.nextRecordIndex,
  });
  if (!merged.accepted && !merged.codes.includes("analysis-merge-conflict"))
    return { kind: "refused" as const, codes: merged.codes };
  if (
    !merged.accepted &&
    (await retainConflict(folder, { ...input, previous })) === "absent"
  )
    return { kind: "absent" as const };
  if (!merged.accepted)
    return { kind: "refused" as const, codes: merged.codes };
  const checkpoint = batchAnalysisCheckpoint(capture, {
    ...input,
    result: merged.result,
  });
  return persistCheckpoint(folder, { ...input, checkpoint });
}

async function bindBatch(folder: string, input: CheckpointInput) {
  const { capture, batchIndex, nextRecordIndex, candidate, mode } = input;
  const text =
    JSON.stringify({
      schemaVersion: 1,
      runId: capture.runId,
      importId: capture.importId,
      capturedDigest: capture.digest,
      batchIndex,
      nextRecordIndex,
      candidateDigest: createHash("sha256")
        .update(JSON.stringify(candidate))
        .digest("hex"),
    }) + "\n";
  const path = join(folder, `batch-claim-${String(batchIndex)}.json`);
  if (mode === "deliver") await matchingPrivateFile(path, text);
  else await inspectMatchingPrivateFile(path, text);
}

async function persistCheckpoint(
  folder: string,
  input: CheckpointInput & {
    readonly checkpoint: ReturnType<typeof batchAnalysisCheckpoint>;
  },
) {
  const { checkpoint, mode } = input;
  const output = {
    cycleId: `checkpoint-${String(checkpoint.completedBatchCount)}`,
    analysis: JSON.stringify(checkpoint) + "\n",
    proposal: checkpointProposal(checkpoint),
  };
  const state = await inspectAnalysisFiles(folder, output);
  await bindBatch(folder, input);
  if (mode === "deliver") await saveAnalysisFiles(folder, output);
  return {
    kind:
      mode === "reconcile" && state === "absent"
        ? ("absent" as const)
        : ("committed" as const),
    checkpoint,
    receipt: createHash("sha256").update(output.analysis).digest("hex"),
  };
}

async function retainConflict(
  folder: string,
  input: CheckpointInput & { readonly previous: AnalysisCheckpoint },
) {
  const { capture, candidate, mode, batchIndex, nextRecordIndex, previous } =
    input;
  const incomingText = JSON.stringify(candidate) + "\n";
  if (Buffer.byteLength(incomingText) > analysisDocumentBytes)
    throw new Error("analysis-output-failed");
  const incomingFile = `conflict-${String(batchIndex)}-incoming.json`;
  const text =
    JSON.stringify({
      schemaVersion: 1,
      runId: capture.runId,
      importId: capture.importId,
      capturedDigest: capture.digest,
      batchIndex,
      nextRecordIndex,
      accepted: {
        file: `analysis-checkpoint-${String(previous.completedBatchCount)}.json`,
        digest: createHash("sha256")
          .update(JSON.stringify(previous) + "\n")
          .digest("hex"),
      },
      incoming: {
        file: incomingFile,
        digest: createHash("sha256").update(incomingText).digest("hex"),
      },
    }) + "\n";
  const path = join(folder, `conflict-${String(batchIndex)}.json`);
  const incomingPath = join(folder, incomingFile);
  await bindBatch(folder, input);
  if (mode === "reconcile") {
    const variant = await inspectMatchingPrivateFile(
      incomingPath,
      incomingText,
    );
    const envelope = await inspectMatchingPrivateFile(path, text);
    return variant === "absent" || envelope === "absent"
      ? "absent"
      : "retained";
  }
  await matchingPrivateFile(incomingPath, incomingText);
  await matchingPrivateFile(path, text);
  return "retained";
}

async function inspectMatchingPrivateFile(path: string, expected: string) {
  const text = await boundedAnalysisFile(path, { permissions: 0o600 }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
  if (text === undefined) return "absent";
  if (text !== expected) throw new Error("analysis-output-failed");
  return "retained";
}

async function previousCheckpoint(
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
