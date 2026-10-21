import { createHash } from "node:crypto";
import type {
  AdapterOutcome,
  DeliveryIntent,
} from "../broker/actor/delivery-intents.ts";
import type { Fields } from "../protocol.ts";
import { validateAnalysis } from "../chats/analysis.ts";
import {
  analysisEvidence,
  type analysisSaveInput,
} from "../chats/analysis-input.ts";
import { mergeAnalysisBatch } from "../chats/analysis-merge.ts";
import { boundAnalysisBatch } from "./chats-batch-binding.ts";
import {
  analysisDirectory,
  inspectAnalysisDraft,
  saveAnalysisDraft,
} from "./chats-files.ts";
import { operationKey } from "./operation-journal.ts";
import { storedAnalysisDraft } from "./chats-follow-up.ts";

interface QuestionSettings {
  readonly runtimeDirectory: string;
  readonly now?: () => string;
}
interface QuestionSave {
  readonly intent: DeliveryIntent;
  readonly mode: "deliver" | "reconcile";
  readonly input: ReturnType<typeof analysisSaveInput>;
  readonly payload: Fields;
}

async function validateQuestion(directory: string, call: QuestionSave) {
  const { input, payload, intent } = call;
  if (!("batch" in payload))
    return validateAnalysis(input.candidate, analysisEvidence(input.snapshot));
  const bound = await boundAnalysisBatch(directory, {
    runId: intent.runId,
    importId: input.snapshot.importId,
    snapshot: "snapshot" in payload ? input.snapshot : undefined,
    batch: payload["batch"],
  });
  return mergeAnalysisBatch({
    previousResult: bound.previous.result,
    candidate: input.candidate,
    evidence: analysisEvidence(bound.snapshot),
    nextRecordIndex: bound.batch.nextRecordIndex,
  });
}

function questionDraft(call: QuestionSave) {
  const { cycleId, snapshot, reply } = call.input;
  return {
    runId: call.intent.runId,
    cycleId,
    operationId: call.intent.operationId,
    inputDigest: call.intent.inputDigest,
    snapshotDigest: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    reply,
    ...("batch" in call.payload ? { batch: call.payload["batch"] } : {}),
  };
}

async function additionalBatchQuestion(
  directory: string,
  call: QuestionSave,
): Promise<boolean> {
  const earlier = await storedAnalysisDraft(directory, call);
  return (
    earlier !== undefined &&
    "batch" in call.payload &&
    earlier.operationId !== call.intent.operationId
  );
}

export async function saveQuestion(
  settings: QuestionSettings,
  call: QuestionSave,
): Promise<AdapterOutcome> {
  try {
    const { cycleId, snapshot } = call.input;
    const directory = await analysisDirectory(
      settings.runtimeDirectory,
      snapshot.importId,
    );
    if (await additionalBatchQuestion(directory, call))
      return {
        kind: "failed",
        reason: "analysis-question-limit",
        result: JSON.stringify({
          kind: "blocked",
          codes: ["analysis-question-limit"],
        }),
      };
    const validation = await validateQuestion(directory, call);
    if (!validation.accepted)
      return {
        kind: "failed",
        reason: validation.codes[0] ?? "analysis-input-refused",
        result: JSON.stringify({ kind: "blocked", codes: validation.codes }),
      };
    const question = validation.result.openQuestion;
    if (question === undefined) throw new Error("analysis-input-refused");
    const draft = questionDraft(call);
    const metadata =
      call.mode === "reconcile"
        ? await inspectAnalysisDraft(directory, draft)
        : await saveAnalysisDraft(directory, {
            input: draft,
            now: settings.now ?? (() => new Date().toISOString()),
          });
    if (metadata === undefined) return { kind: "absent" };
    return {
      kind: "completed",
      worker: "chats",
      receipt: operationKey(call.intent.operationId),
      result: JSON.stringify({
        kind: "analysis_draft",
        cycleId,
        ...metadata,
        question,
      }),
    };
  } catch {
    throw new Error("analysis-output-failed");
  }
}
