import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterOutcome,
  DeliveryIntent,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";
import { analysisPrompt } from "../chats/analysis-prompt.ts";
import { isAnalysisSnapshot } from "../chats/analysis-input.ts";
import { record } from "../protocol.ts";
import { sumPrices } from "../worker-usage.ts";
import type { RunningTurn, TurnEnd } from "./claude-turn.ts";
import { startRetriedTurn, type RetrySettings } from "./retrying-turn.ts";
import { analysisAvailable, analysisMethod } from "./analysis-launch.ts";
import { analysisToken } from "./analysis-token.ts";
import {
  located,
  readRecord,
  writeRecord,
  replied,
  reportOf,
  interrupted,
  type Recorded,
  type WorkerReport,
} from "./operation-journal.ts";

interface Settings extends RetrySettings {
  readonly journal: string;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly report: (report: WorkerReport) => Promise<unknown>;
  readonly stopMilliseconds?: number;
}

interface AnalysisWorker {
  readonly deliver: (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ) => Promise<
    AdapterOutcome | { readonly receipt: string; readonly worker: string }
  >;
  readonly reconcile: (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ) => Promise<AdapterOutcome>;
  readonly stop: (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ) => Promise<AdapterOutcome>;
  readonly close: () => Promise<void>;
}

interface Active {
  readonly turn: RunningTurn;
  readonly done: Promise<void>;
}

function own(intent: DeliveryIntent): intent is ProtectedIntent {
  return (
    intent.kind === "protected-effect" &&
    intent.capability === "claude" &&
    intent.method === analysisMethod &&
    intent.target !== undefined &&
    intent.payload !== undefined &&
    intent.leaseGeneration !== undefined
  );
}

function failed(reason: string): AdapterOutcome {
  return { kind: "failed", reason };
}

function snapshotOf(text: string | undefined): unknown {
  try {
    return record(JSON.parse(text ?? "null"))?.["snapshot"];
  } catch {
    return undefined;
  }
}

async function cleaned(folder: string): Promise<void> {
  await Promise.all(
    ["configuration", "working"].map((name) =>
      rm(join(folder, name), { recursive: true, force: true }),
    ),
  );
}

async function privateRecord(
  folder: string,
  entry: { readonly name: string; readonly value: unknown },
): Promise<void> {
  await writeRecord(folder, { ...entry, permissions: "private" });
}

function outcome(end: TurnEnd): Recorded {
  const endedAt = new Date().toISOString();
  if (end.stopped) return { outcome: "stopped", endedAt };
  const result = end.result;
  if (result === undefined)
    return { ...interrupted("analysis-turn-failed"), endedAt };
  const fields = {
    costUsd: result.costUsd,
    usage: result.usage,
    model: result.model,
    ...(result.attempts === undefined ? {} : { attempts: result.attempts }),
    sessionId: result.sessionId,
    turns: result.turns,
    estimatedCostUsd: sumPrices(
      (result.attempts ?? []).map((attempt) => attempt.estimatedCostUsd),
    ),
  };
  if (end.exitCode !== 0 || result.failed)
    return {
      outcome: "failed",
      reason: "analysis-turn-failed",
      endedAt,
      result: JSON.stringify(fields),
    };
  if (Buffer.byteLength(result.text, "utf8") > 16_000)
    return {
      outcome: "failed",
      reason: "analysis-reply-too-large",
      endedAt,
      result: JSON.stringify(fields),
    };
  return {
    outcome: "completed",
    endedAt,
    result: JSON.stringify({ ...fields, reply: result.text }),
  };
}

function running(processId: unknown): boolean {
  if (typeof processId !== "number") return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

interface Parts {
  readonly settings: Settings;
  readonly active: Map<string, Active>;
  readonly preparing: Map<string, ReturnType<AnalysisWorker["deliver"]>>;
  readonly stopping: AbortController;
}

async function reconcile(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  if (!own(intent)) return failed("unsupported-effect");
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const result = await readRecord(folder, "result.json");
  if (result !== undefined) {
    await cleaned(folder);
    return replied({ receipt: key, worker: "claude" }, result);
  }
  if (parts.active.has(key))
    return { kind: "accepted", receipt: key, worker: "claude" };
  const started = await readRecord(folder, "started.json");
  if (started === undefined) return { kind: "absent" };
  if (running(record(started)?.["processId"]))
    return { kind: "unknown", evidence: key };
  const ending = interrupted("analysis-turn-failed");
  await privateRecord(folder, { name: "result.json", value: ending });
  await cleaned(folder);
  return replied({ receipt: key, worker: "claude" }, ending);
}

async function begun(
  parts: Parts,
  opening: {
    readonly intent: ProtectedIntent;
    readonly folder: string;
    readonly key: string;
    readonly directory: string;
    readonly prompt: string;
    readonly token: string;
  },
): Promise<void> {
  const { intent, folder, key, directory, prompt } = opening;
  const started = {
    operationId: intent.operationId,
    target: intent.target,
    mode: "analysis",
    startedAt: new Date().toISOString(),
  };
  const turn = await startRetriedTurn(
    {
      mode: "analysis",
      analysisToken: opening.token,
      command: [],
      folder,
      directory,
      prompt,
    },
    { ...parts.settings, metadata: started },
  );
  const done = turn.ended
    .then(async (end) => {
      const result = outcome(end);
      await privateRecord(folder, { name: "result.json", value: result });
      await cleaned(folder);
      await parts.settings.report(
        reportOf(
          { intent, worker: "claude", commandId: `analysis-turn:${key}` },
          result,
        ),
      );
    })
    .catch(() => undefined)
    .finally(() => parts.active.delete(key));
  parts.active.set(key, { turn, done });
}

function cancelled(parts: Parts, signal: AbortSignal): boolean {
  return signal.aborted || parts.stopping.signal.aborted;
}

async function deliver(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
) {
  const { intent, signal } = call;
  if (!own(intent)) return failed("unsupported-effect");
  const known = await reconcile(parts, intent);
  if (known.kind !== "absent") return known;
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const text = await parts.settings.document(intent.payload);
  const snapshot = snapshotOf(text);
  if (!isAnalysisSnapshot(snapshot) || snapshot.importId !== intent.target)
    return failed("analysis-input-refused");
  await mkdir(join(folder, "configuration"), { recursive: true, mode: 0o700 });
  if (!(await analysisAvailable(folder))) {
    await cleaned(folder);
    return failed("analysis-worker-unavailable");
  }
  if (cancelled(parts, signal)) {
    await cleaned(folder);
    return failed("analysis-turn-failed");
  }
  const credential = await analysisToken(folder, signal);
  if (cancelled(parts, signal)) {
    await cleaned(folder);
    return failed("analysis-turn-failed");
  }
  if ("error" in credential) {
    await cleaned(folder);
    return {
      ...failed("analysis-worker-unavailable"),
      result: JSON.stringify({ error: credential.error }),
    };
  }
  const directory = join(folder, "working");
  await mkdir(directory, { mode: 0o700 });
  await begun(parts, {
    intent,
    key,
    folder,
    directory,
    prompt: analysisPrompt(snapshot),
    token: credential.token,
  });
  return { receipt: key, worker: "claude" };
}

async function halted(parts: Parts, active: Active): Promise<void> {
  active.turn.stop(parts.settings.stopMilliseconds ?? 2_000);
  await active.done;
}

function delivered(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): ReturnType<AnalysisWorker["deliver"]> {
  if (cancelled(parts, call.signal))
    return Promise.resolve(failed("analysis-turn-failed"));
  const key = call.intent.operationId;
  const known = parts.preparing.get(key);
  if (known !== undefined) return known;
  const signal = AbortSignal.any([call.signal, parts.stopping.signal]);
  const pending = deliver(parts, { ...call, signal }).finally(() =>
    parts.preparing.delete(key),
  );
  parts.preparing.set(key, pending);
  return pending;
}

export function analysisWorker(settings: Settings): AnalysisWorker {
  const parts: Parts = {
    settings,
    active: new Map(),
    preparing: new Map(),
    stopping: new AbortController(),
  };
  return {
    deliver: (intent, signal) => delivered(parts, { intent, signal }),
    reconcile: (intent) => reconcile(parts, intent),
    stop: async (intent) => {
      const active = parts.active.get(
        located(settings.journal, intent.operationId).key,
      );
      if (active !== undefined) await halted(parts, active);
      return reconcile(parts, intent);
    },
    close: async () => {
      parts.stopping.abort();
      await Promise.all(parts.preparing.values());
      await Promise.all(
        [...parts.active.values()].map((active) => halted(parts, active)),
      );
    },
  };
}
