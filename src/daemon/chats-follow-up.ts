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

async function boundDraft(
  directory: string,
  call: FollowUpSave,
): Promise<AnalysisDraftInput> {
  const { snapshot, cycleId } = call.input;
  const followUp = analysisFollowUp(call.payload["followUp"]);
  const text = await boundedAnalysisFile(
    join(directory, `draft-${cycleId}.json`),
    { permissions: 0o600 },
  );
  const stored = record(JSON.parse(text));
  if (
    stored?.["runId"] !== call.intent.runId ||
    stored["cycleId"] !== cycleId ||
    typeof stored["operationId"] !== "string" ||
    typeof stored["inputDigest"] !== "string" ||
    typeof stored["reply"] !== "string" ||
    stored["snapshotDigest"] !==
      createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") ||
    JSON.stringify(JSON.parse(stored["reply"])) !==
      JSON.stringify(followUp.draft)
  )
    throw new Error("analysis-follow-up-refused");
  const draft = {
    runId: call.intent.runId,
    cycleId,
    operationId: stored["operationId"],
    inputDigest: stored["inputDigest"],
    snapshotDigest: stored["snapshotDigest"],
    reply: stored["reply"],
  };
  if ((await inspectAnalysisDraftRecord(directory, draft)) === undefined)
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
