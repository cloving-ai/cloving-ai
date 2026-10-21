import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  AdapterOutcome,
  DeliveryIntent,
} from "../broker/actor/delivery-intents.ts";
import { record, type Fields } from "../protocol.ts";
import { analysisFollowUp } from "../chats/analysis-prompt.ts";
import {
  analysisEvidence,
  type AnalysisSnapshot,
} from "../chats/analysis-input.ts";
import { validateAnalysis } from "../chats/analysis.ts";
import { analysisProposal } from "../chats/analysis-proposal.ts";
import { analysisBatchData } from "../chats/analysis-batches.ts";
import { finalizeAnalysis } from "./chats-checkpoints.ts";
import { operationKey } from "./operation-journal.ts";
import {
  analysisDirectory,
  boundedAnalysisFile,
  inspectAnalysisDraftRecord,
  inspectAnalysisFiles,
  saveAnalysisFiles,
  type AnalysisDraftInput,
} from "./chats-files.ts";

interface FollowUpSave {
  readonly intent: DeliveryIntent;
  readonly payload: Fields;
  readonly mode: "deliver" | "reconcile";
  readonly input: {
    readonly cycleId: string;
    readonly snapshot: AnalysisSnapshot;
    readonly candidate: unknown;
  };
}

function storedDraftIdentity(
  stored: Fields | undefined,
  call: FollowUpSave,
): stored is Fields & {
  readonly operationId: string;
  readonly inputDigest: string;
  readonly reply: string;
  readonly snapshotDigest: string;
} {
  return (
    stored?.["runId"] === call.intent.runId &&
    stored["cycleId"] === call.input.cycleId &&
    typeof stored["operationId"] === "string" &&
    typeof stored["inputDigest"] === "string" &&
    typeof stored["reply"] === "string" &&
    stored["snapshotDigest"] ===
      createHash("sha256")
        .update(JSON.stringify(call.input.snapshot))
        .digest("hex")
  );
}

export async function storedAnalysisDraft(
  directory: string,
  call: FollowUpSave,
): Promise<AnalysisDraftInput | undefined> {
  const { cycleId } = call.input;
  const text = await boundedAnalysisFile(
    join(directory, `draft-${cycleId}.json`),
    { permissions: 0o600 },
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const stored = record(JSON.parse(text));
  if (!storedDraftIdentity(stored, call))
    throw new Error("analysis-follow-up-refused");
  const draft = {
    runId: call.intent.runId,
    cycleId,
    operationId: stored["operationId"],
    inputDigest: stored["inputDigest"],
    snapshotDigest: stored["snapshotDigest"],
    reply: stored["reply"],
    ...("batch" in stored ? { batch: stored["batch"] } : {}),
  };
  if ((await inspectAnalysisDraftRecord(directory, draft)) === undefined)
    throw new Error("analysis-follow-up-refused");
  return draft;
}

async function boundDraft(
  directory: string,
  call: FollowUpSave,
): Promise<AnalysisDraftInput> {
  const followUp = analysisFollowUp(call.payload["followUp"]);
  const draft = await storedAnalysisDraft(directory, call);
  if (
    draft === undefined ||
    JSON.stringify(draft.batch) !== JSON.stringify(call.payload["batch"]) ||
    JSON.stringify(JSON.parse(draft.reply)) !== JSON.stringify(followUp.draft)
  )
    throw new Error("analysis-follow-up-refused");
  return draft;
}

function refused(
  reason: string,
  codes: readonly string[] = [reason],
): AdapterOutcome {
  return {
    kind: "failed",
    reason,
    result: JSON.stringify({ kind: "blocked", codes }),
  };
}

export async function saveFollowUp(
  runtime: string,
  call: FollowUpSave,
): Promise<AdapterOutcome> {
  const { snapshot, cycleId, candidate } = call.input;
  try {
    if ("batch" in call.payload) {
      if (Object.hasOwn(record(candidate) ?? {}, "openQuestion"))
        return refused("analysis-question-limit");
      const directory = await analysisDirectory(runtime, snapshot.importId);
      const draft = await boundDraft(directory, call);
      return await saveAcceptedAnalysis(runtime, { ...call, draft });
    }
    const validation = validateAnalysis(candidate, analysisEvidence(snapshot));
    if (!validation.accepted)
      return refused("analysis-follow-up-refused", validation.codes);
    if (validation.result.openQuestion !== undefined)
      return refused("analysis-question-limit");
    const directory = await analysisDirectory(runtime, snapshot.importId);
    const draft = await boundDraft(directory, call);
    const output = {
      cycleId,
      draft,
      analysis: JSON.stringify(validation.result) + "\n",
      proposal: analysisProposal(validation.result),
    };
    if (
      call.mode === "reconcile" &&
      (await inspectAnalysisFiles(directory, output)) === "absent"
    )
      return { kind: "absent" };
    if (call.mode === "deliver") await saveAnalysisFiles(directory, output);
  } catch {
    return refused("analysis-follow-up-refused");
  }
  return {
    kind: "completed",
    worker: "chats",
    receipt: operationKey(call.intent.operationId),
    result: JSON.stringify({
      kind: "handoff_requested",
      cycleId,
      promotionId: `analysis:${snapshot.importId}:${cycleId}`,
    }),
  };
}

async function acceptedDraft(
  directory: string,
  call: FollowUpSave,
): Promise<AnalysisDraftInput | undefined> {
  const draft = await storedAnalysisDraft(directory, call);
  if (draft === undefined) return undefined;
  const batch = record(call.payload["batch"]);
  const prior = record(draft.batch);
  if (
    prior === undefined ||
    batch === undefined ||
    Number(batch["batchIndex"]) === Number(prior["batchIndex"])
  )
    throw new Error("analysis-follow-up-refused");
  if (Number(batch["batchIndex"]) < Number(prior["batchIndex"]))
    return undefined;
  return draft;
}

export async function saveAcceptedAnalysis(
  runtime: string,
  call: FollowUpSave & { readonly draft?: AnalysisDraftInput },
): Promise<AdapterOutcome> {
  const { snapshot, cycleId, candidate } = call.input;
  const { importId } = snapshot;
  try {
    const directory = await analysisDirectory(runtime, importId);
    const draft =
      call.draft ??
      ("batch" in call.payload
        ? await acceptedDraft(directory, call)
        : undefined);
    const saved = await finalizeAnalysis(directory, {
      runId: call.intent.runId,
      importId,
      cycleId,
      snapshot: "snapshot" in call.payload ? snapshot : undefined,
      candidate,
      mode: call.mode,
      batch: call.payload["batch"],
      ...(draft === undefined ? {} : { draft }),
    });
    return savedOutcome(call, saved);
  } catch {
    throw new Error("analysis-output-failed");
  }
}

function savedOutcome(
  call: FollowUpSave & { readonly draft?: AnalysisDraftInput },
  saved: Awaited<ReturnType<typeof finalizeAnalysis>>,
): AdapterOutcome {
  const { cycleId, snapshot } = call.input;
  const { importId } = snapshot;
  if (saved.kind === "absent") return { kind: "absent" };
  if (saved.kind === "refused")
    return refused(
      call.draft !== undefined &&
        !saved.codes.includes("analysis-merge-conflict")
        ? "analysis-follow-up-refused"
        : (saved.codes[0] ?? "analysis-input-refused"),
      saved.codes,
    );
  let result: unknown = {
    kind: "handoff_requested",
    cycleId,
    promotionId: `analysis:${importId}:${cycleId}`,
  };
  if (saved.next?.kind === "refused")
    result = { kind: "analysis_partial", reason: saved.next.code };
  if (saved.next?.kind === "batch")
    result = {
      kind: "analysis_batch",
      ...analysisBatchData(saved.next, {
        digest: saved.checkpoint.capturedDigest,
      }),
    };
  return {
    kind: "completed",
    worker: "chats",
    receipt: operationKey(call.intent.operationId),
    result: JSON.stringify(result),
  };
}
