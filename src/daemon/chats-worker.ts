import { saveQuestion } from "./chats-question.ts";
import type { AnalysisQuestion } from "../chats/analysis-contract.ts";
import { saveAcceptedAnalysis, saveFollowUp } from "./chats-follow-up.ts";
import type {
  AdapterOutcome,
  DeliveryIntent,
} from "../broker/actor/delivery-intents.ts";
import type { EffectDelivery } from "./delivery-router.ts";
import { record, type Fields } from "../protocol.ts";
import { validateAnalysis } from "../chats/analysis.ts";
import {
  analysisDocumentBytes,
  analysisEvidence,
  analysisSaveInput,
  validAnalysisImportId,
} from "../chats/analysis-input.ts";
import {
  analysisBatchData,
  prepareAnalysisBatch,
} from "../chats/analysis-batches.ts";
import {
  captureAnalysisSnapshot,
  readCapturedAnalysisSnapshot,
  findAnalysisCapture,
} from "./chats-capture.ts";
import { operationKey } from "./operation-journal.ts";
import { analysisDirectory } from "./chats-files.ts";

export interface ChatsWorkerSettings {
  readonly runtimeDirectory: string;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly workflowId: (runId: string) => Promise<string | undefined>;
  readonly now?: () => string;
}

export interface ChatsWorker extends EffectDelivery {
  readonly deliver: (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ) => Promise<AdapterOutcome>;
  readonly close: () => Promise<void>;
}

type ChatsResult =
  | ReturnType<typeof analysisBatchData>
  | ({ readonly kind: "analysis_batch" } & ReturnType<typeof analysisBatchData>)
  | { readonly kind: "analysis_partial"; readonly reason: string }
  | {
      readonly kind: "analysis_draft";
      readonly cycleId: string;
      readonly candidateDigest: string;
      readonly expiresAt: string;
      readonly question: AnalysisQuestion;
    }
  | {
      readonly kind: "handoff_requested";
      readonly cycleId: string;
      readonly promotionId: string;
    };

function completed(
  intent: DeliveryIntent,
  result: ChatsResult,
): AdapterOutcome {
  return {
    kind: "completed",
    worker: "chats",
    receipt: operationKey(intent.operationId),
    result: JSON.stringify(result),
  };
}

function refused(
  code: string,
  codes: readonly string[] = [code],
): AdapterOutcome {
  return {
    kind: "failed",
    reason: code,
    result: JSON.stringify({ kind: "blocked", codes }),
  };
}

function bounded(text: string): void {
  if (Buffer.byteLength(text) > analysisDocumentBytes)
    throw new Error("analysis-too-large");
}

function ownIntent(intent: DeliveryIntent): boolean {
  return (
    intent.kind === "protected-effect" &&
    intent.capability === "chats" &&
    ["read-analysis", "save-analysis"].includes(intent.method ?? "") &&
    intent.payload !== undefined &&
    intent.leaseGeneration !== undefined
  );
}

async function payloadOf(
  settings: ChatsWorkerSettings,
  intent: DeliveryIntent,
): Promise<Fields> {
  if (!ownIntent(intent) || intent.payload === undefined)
    throw new Error("unsupported-effect");
  if ((await settings.workflowId(intent.runId)) !== "analyze-chats")
    throw new Error("workflow-not-allowed");
  const text = await settings.document(intent.payload);
  if (text === undefined) throw new Error("payload-not-available");
  bounded(text);
  const payload = record(JSON.parse(text));
  if (payload === undefined) throw new Error("analysis-input-refused");
  const importId = payload["importId"];
  if (typeof importId !== "string" || importId === "")
    throw new Error("analysis-input-refused");
  if (!validAnalysisImportId(importId)) throw new Error("invalid-import-id");
  if (intent.target !== importId) throw new Error("analysis-input-refused");
  return payload;
}

async function read(
  settings: ChatsWorkerSettings,
  call: { readonly intent: DeliveryIntent; readonly importId: string },
): Promise<AdapterOutcome> {
  const { importId } = call;
  let directory: string;
  try {
    directory = await analysisDirectory(settings.runtimeDirectory, importId);
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT")
      throw new Error("redaction-required", { cause: error });
    throw error;
  }
  const capture = await captureAnalysisSnapshot(directory, {
    importId,
    runId: call.intent.runId,
  });
  const snapshot = await readCapturedAnalysisSnapshot(directory, capture);
  const batch = prepareAnalysisBatch(snapshot, {
    nextRecordIndex: 0,
    completedBatchCount: 0,
    previousResult: null,
  });
  if (batch.kind === "refused") throw new Error(batch.code);
  const result = analysisBatchData(batch, { digest: capture.digest, snapshot });
  bounded(JSON.stringify(result));
  return completed(call.intent, result);
}

async function saveInput(settings: ChatsWorkerSettings, call: SaveCall) {
  if ("snapshot" in call.payload) return analysisSaveInput(call.payload);
  const importId = String(call.payload["importId"]);
  const directory = await analysisDirectory(
    settings.runtimeDirectory,
    importId,
  );
  const capture = await findAnalysisCapture(directory, {
    runId: call.intent.runId,
    importId,
  });
  if (capture === undefined) throw new Error("analysis-output-failed");
  const snapshot = await readCapturedAnalysisSnapshot(directory, capture);
  return analysisSaveInput({ ...call.payload, snapshot });
}

interface SaveCall {
  readonly intent: DeliveryIntent;
  readonly payload: Fields;
  readonly mode: "deliver" | "reconcile";
}

async function save(
  settings: ChatsWorkerSettings,
  call: SaveCall,
): Promise<AdapterOutcome> {
  const input = await saveInput(settings, call);
  const { snapshot, candidate } = input;
  if ("followUp" in call.payload)
    return saveFollowUp(settings.runtimeDirectory, { ...call, input });
  if (
    "batch" in call.payload &&
    Object.hasOwn(record(candidate) ?? {}, "openQuestion")
  )
    return saveQuestion(settings, { ...call, input });
  const validation =
    "batch" in call.payload
      ? undefined
      : validateAnalysis(candidate, analysisEvidence(snapshot));
  if (validation === undefined)
    return saveAcceptedAnalysis(settings.runtimeDirectory, { ...call, input });
  if (!validation.accepted)
    return refused(
      validation.codes[0] ?? "analysis-input-refused",
      validation.codes,
    );
  const question = validation.result.openQuestion;
  if (question !== undefined) return saveQuestion(settings, { ...call, input });
  return saveAcceptedAnalysis(settings.runtimeDirectory, { ...call, input });
}

const reasons = new Set([
  "analysis-too-large",
  "redaction-required",
  "invalid-import-id",
  "analysis-invalid-json",
  "analysis-follow-up-refused",
  "analysis-input-refused",
  "analysis-output-failed",
  "analysis-batch-limit",
  "unsupported-effect",
  "workflow-not-allowed",
  "payload-not-available",
]);

async function delivered(
  settings: ChatsWorkerSettings,
  call: {
    readonly intent: DeliveryIntent;
    readonly mode: "deliver" | "reconcile";
    readonly signal?: AbortSignal;
  },
): Promise<AdapterOutcome> {
  const { intent, mode } = call;
  try {
    if (call.signal?.aborted) return { kind: "stopped" };
    const payload = await payloadOf(settings, intent);
    if (call.signal?.aborted) return { kind: "stopped" };
    if (intent.method === "read-analysis" && mode === "reconcile")
      return { kind: "absent" };
    if (intent.method === "read-analysis")
      return await read(settings, {
        intent,
        importId: String(payload["importId"]),
      });
    return await save(settings, { intent, payload, mode });
  } catch (error) {
    const message = String(Reflect.get(Object(error), "message"));
    return refused(reasons.has(message) ? message : "analysis-input-refused");
  }
}

export function chatsWorker(settings: ChatsWorkerSettings): ChatsWorker {
  if (process.platform !== "darwin") {
    const unsupported = () => Promise.resolve(refused("platform-unsupported"));
    return {
      deliver: unsupported,
      reconcile: unsupported,
      stop: unsupported,
      close: () => Promise.resolve(),
    };
  }
  const active = new Map<string, Promise<AdapterOutcome>>();
  const lifecycle = { closed: false };
  const deliver = (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ): Promise<AdapterOutcome> => {
    if (lifecycle.closed || signal.aborted)
      return Promise.resolve({ kind: "stopped" });
    const key = operationKey(
      JSON.stringify([intent.runId, intent.operationId, intent.inputDigest]),
    );
    const known = active.get(key);
    if (known !== undefined) return known;
    const pending = delivered(settings, {
      intent,
      mode: "deliver",
      signal,
    }).finally(() => active.delete(key));
    active.set(key, pending);
    return pending;
  };
  const stop = async (intent: DeliveryIntent): Promise<AdapterOutcome> => {
    if (!ownIntent(intent)) return refused("unsupported-effect");
    if ((await settings.workflowId(intent.runId)) !== "analyze-chats")
      return refused("workflow-not-allowed");
    const key = operationKey(
      JSON.stringify([intent.runId, intent.operationId, intent.inputDigest]),
    );
    const pending = active.get(key);
    if (pending !== undefined) return await pending;
    const result = await delivered(settings, { intent, mode: "reconcile" });
    return result.kind === "absent" ? { kind: "stopped" } : result;
  };
  return {
    deliver,
    reconcile: (intent) => delivered(settings, { intent, mode: "reconcile" }),
    stop,
    close: async () => {
      lifecycle.closed = true;
      await Promise.all(active.values());
    },
  };
}
