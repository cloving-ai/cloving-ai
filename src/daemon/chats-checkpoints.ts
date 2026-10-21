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
  readonly cycleId: string;
  readonly snapshot: AnalysisSnapshot;
  readonly candidate: unknown;
  readonly mode: "deliver" | "reconcile";
}

export async function finalizeAnalysis(
  directory: string,
  input: FinalizeInput,
) {
  const capture = await findAnalysisCapture(directory, {
    runId: input.runId,
    importId: input.snapshot.importId,
  });
  if (
    capture === undefined ||
    JSON.stringify(await readCapturedAnalysisSnapshot(directory, capture)) !==
      JSON.stringify(input.snapshot)
  )
    throw new Error("analysis-output-failed");
  const batch = {
    capture,
    candidate: input.candidate,
    batchIndex: 0,
    nextRecordIndex: capture.totalRecords,
  };
  const inspected = await saveAnalysisCheckpoint(directory, {
    ...batch,
    mode: "reconcile",
  });
  if (inspected.kind === "refused") return inspected;
  if (!("checkpoint" in inspected)) return { kind: "absent" as const };
  const output = {
    cycleId: input.cycleId,
    analysis: JSON.stringify(inspected.checkpoint.result) + "\n",
    proposal: analysisProposal(inspected.checkpoint.result),
  };
  const legacy = await inspectAnalysisFiles(directory, output);
  if (input.mode === "reconcile")
    return inspected.kind === "absent" || legacy === "absent"
      ? { kind: "absent" as const }
      : inspected;
  const saved = await saveAnalysisCheckpoint(directory, {
    ...batch,
    mode: "deliver",
  });
  if (saved.kind !== "committed") return saved;
  await saveAnalysisFiles(directory, output);
  return saved;
}

export async function saveAnalysisCheckpoint(
  directory: string,
  input: CheckpointInput,
) {
  const { capture, candidate, mode } = input;
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
  await bindBatch(folder, input);
  if (!merged.accepted) {
    if (
      merged.codes.includes("analysis-merge-conflict") &&
      (await retainConflict(folder, { ...input, previous })) === "absent"
    )
      return { kind: "absent" as const };
    return { kind: "refused" as const, codes: merged.codes };
  }
  const checkpoint = batchAnalysisCheckpoint(capture, {
    ...input,
    result: merged.result,
  });
  return persistCheckpoint(folder, { checkpoint, mode });
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
  input: {
    readonly checkpoint: ReturnType<typeof batchAnalysisCheckpoint>;
    readonly mode: CheckpointInput["mode"];
  },
) {
  const { checkpoint, mode } = input;
  const output = {
    cycleId: `checkpoint-${String(checkpoint.completedBatchCount)}`,
    analysis: JSON.stringify(checkpoint) + "\n",
    proposal: checkpointProposal(checkpoint),
  };
  const state = await inspectAnalysisFiles(folder, output);
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
