import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterOutcome,
  DeliveryIntent,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";
import { send } from "../cli/client.ts";
import { record, type Reply } from "../protocol.ts";
import { runIdentity } from "../service/submission-handler.ts";
import type { EffectDelivery } from "./delivery-router.ts";
import { located, readRecord, writeRecord } from "./operation-journal.ts";

interface Settings {
  readonly runtimeDirectory: string;
  readonly journal: string;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly runStatus: (runId: string) => Promise<string | undefined>;
  readonly retryMilliseconds?: number;
}

const attempts = 10;
const uncertain = [
  "outcome-unknown",
  "service-unavailable",
  "service-busy",
  "storage-failure",
  "authority-unavailable",
  "resolver-timeout",
  "resolver-failure",
];

function own(intent: DeliveryIntent): intent is ProtectedIntent {
  return (
    intent.kind === "protected-effect" &&
    intent.capability === "handoff" &&
    intent.method === "run" &&
    intent.target !== undefined &&
    intent.payload !== undefined &&
    intent.leaseGeneration !== undefined
  );
}

function completed(runId: string): AdapterOutcome {
  return {
    kind: "completed",
    worker: "handoff",
    receipt: runId,
    result: runId,
  };
}

async function saved(folder: string): Promise<AdapterOutcome | undefined> {
  const stored = record(await readRecord(folder, "result.json"));
  if (stored === undefined) return undefined;
  if (stored["kind"] === "completed" && typeof stored["result"] === "string")
    return completed(stored["result"]);
  if (stored["kind"] === "failed" && typeof stored["reason"] === "string")
    return { kind: "failed", reason: stored["reason"] };
  throw new Error("invalid-handoff-journal");
}

async function retained(
  folder: string,
  outcome: AdapterOutcome,
): Promise<AdapterOutcome> {
  if (["completed", "failed"].includes(outcome.kind))
    await writeRecord(folder, {
      name: "result.json",
      value: outcome,
      permissions: "private",
    });
  return outcome;
}

function outcome(reply: Reply): AdapterOutcome | undefined {
  if (reply.kind === "error") {
    if (reply.error.code === "workflow-active") return undefined;
    return uncertain.includes(reply.error.code)
      ? { kind: "unknown" }
      : { kind: "failed", reason: "handoff-input-refused" };
  }
  const runId = reply.result["runId"];
  return reply.result["kind"] === "run-admitted" && typeof runId === "string"
    ? completed(runId)
    : { kind: "unknown" };
}

async function input(settings: Settings, intent: ProtectedIntent) {
  const text = await settings.document(intent.payload);
  try {
    return record(JSON.parse(text ?? "null"));
  } catch {
    return undefined;
  }
}

async function submit(
  settings: Settings,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): Promise<AdapterOutcome> {
  const { intent, signal } = call;
  if (!own(intent)) return { kind: "failed", reason: "unsupported-effect" };
  const { folder } = located(settings.journal, intent.operationId);
  const known = await saved(folder);
  if (known !== undefined) return known;
  const submission = await input(settings, intent);
  if (submission === undefined)
    return retained(folder, {
      kind: "failed",
      reason: "handoff-input-refused",
    });
  const previous = await busyAttempts(folder);
  for (let busy = previous; busy < attempts; busy += 1) {
    if (!(await allowed(settings, { intent, signal })))
      return { kind: "unknown" };
    const reply = await submitted(settings, {
      intent,
      submission,
      signal,
      folder,
    });
    if (reply === undefined) return { kind: "unknown" };
    const result = outcome(reply);
    if (result !== undefined) return retained(folder, result);
    await writeRecord(folder, {
      name: "attempts.json",
      value: { busy: busy + 1 },
      permissions: "private",
    });
    if (busy + 1 < attempts)
      await delay(settings.retryMilliseconds ?? 1000, undefined, {
        signal,
      }).catch(() => undefined);
  }
  return retained(folder, { kind: "failed", reason: "handoff-start-timeout" });
}

async function submitted(
  settings: Settings,
  call: {
    readonly intent: ProtectedIntent;
    readonly submission: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
    readonly folder: string;
  },
): Promise<Reply | undefined> {
  const { intent, submission, folder, signal } = call;
  const marker = (status: "pending" | "settled") =>
    writeRecord(folder, {
      name: "submission.json",
      value: { processId: process.pid, pending: status === "pending" },
      permissions: "private",
    });
  await marker("pending");
  if (!(await allowed(settings, { intent, signal }))) {
    await marker("settled");
    return undefined;
  }
  const reply = await send(settings.runtimeDirectory, {
    operation: "run",
    parameters: {
      workflowId: intent.target,
      source: "input",
      submission,
      commandId: `handoff:${intent.operationId}`,
    },
  });
  if (reply.kind !== "error" || reply.error.code !== "outcome-unknown")
    await marker("settled");
  return reply;
}

async function allowed(
  settings: Settings,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): Promise<boolean> {
  try {
    call.signal.throwIfAborted();
    const status = await settings.runStatus(call.intent.runId);
    call.signal.throwIfAborted();
    return status === "running";
  } catch {
    return false;
  }
}

async function inFlight(folder: string): Promise<boolean> {
  const marker = record(await readRecord(folder, "submission.json"));
  if (marker?.["pending"] !== true) return false;
  const pid = marker["processId"];
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("invalid-handoff-journal");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function busyAttempts(folder: string): Promise<number> {
  const previous =
    record(await readRecord(folder, "attempts.json"))?.["busy"] ?? 0;
  if (
    typeof previous !== "number" ||
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous > attempts
  )
    throw new Error("invalid-handoff-journal");
  return previous;
}

async function observed(
  settings: Settings,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  if (!own(intent)) return { kind: "failed", reason: "unsupported-effect" };
  const known = await saved(
    located(settings.journal, intent.operationId).folder,
  );
  if (known !== undefined) return known;
  const reply = await send(settings.runtimeDirectory, {
    operation: "status",
    parameters: { runId: runIdentity(`handoff:${intent.operationId}`) },
  });
  if (reply.kind === "error")
    return reply.error.code === "unknown-run"
      ? {
          kind: (await inFlight(
            located(settings.journal, intent.operationId).folder,
          ))
            ? "unknown"
            : "absent",
        }
      : { kind: "unknown" };
  const runId = record(reply.result["run"])?.["runId"];
  return typeof runId === "string" ? completed(runId) : { kind: "unknown" };
}

export function handoffWorker(settings: Settings): EffectDelivery {
  const pending = new Map<
    string,
    {
      readonly stopping: AbortController;
      readonly result: Promise<AdapterOutcome>;
    }
  >();
  const deliver = (
    intent: DeliveryIntent,
    signal: AbortSignal,
  ): Promise<AdapterOutcome> => {
    const known = pending.get(intent.operationId);
    if (known !== undefined) return known.result;
    const stopping = new AbortController();
    const result = submit(settings, {
      intent,
      signal: AbortSignal.any([signal, stopping.signal]),
    }).finally(() => pending.delete(intent.operationId));
    pending.set(intent.operationId, { stopping, result });
    return result;
  };
  return {
    deliver,
    reconcile: (intent) => observed(settings, intent),
    stop: async (intent) => {
      const active = pending.get(intent.operationId);
      active?.stopping.abort();
      await active?.result;
      const known = await observed(settings, intent);
      return known.kind === "absent" ? { kind: "stopped" } : known;
    },
  };
}
