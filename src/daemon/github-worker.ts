import type {
  AdapterOutcome,
  Delivery,
  DeliveryIntent,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";
import { calls } from "./github-calls.ts";
import {
  methodReasons,
  methods,
  type Method,
  type MethodSettings,
} from "./github-methods.ts";
import {
  interrupted,
  located,
  readRecord,
  replied,
  reportOf,
  writeRecord,
  type Identity,
  type Located,
  type Recorded,
  type WorkerReport,
} from "./operation-journal.ts";

export type { GithubTiming } from "./github-methods.ts";

export interface GithubWorkerSettings extends MethodSettings {
  readonly journal: string;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly report: (report: WorkerReport) => Promise<unknown>;
}

export interface GithubWorker extends Delivery {
  readonly stop: NonNullable<Delivery["stop"]>;
  readonly close: () => Promise<void>;
}

const worker = "github";

interface Active {
  readonly stopping: AbortController;
  readonly concluded: Promise<void>;
}

interface Parts {
  readonly settings: GithubWorkerSettings;
  readonly active: Map<string, Active>;
}

interface Started extends Located {
  readonly intent: ProtectedIntent;
  readonly method: Method;
  readonly payload: Readonly<Record<string, unknown>>;
}

function placed(parts: Parts, intent: DeliveryIntent): Located {
  return located(parts.settings.journal, intent.operationId);
}

async function reconciled(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const { key, folder } = placed(parts, intent);
  const identity: Identity = { receipt: key, worker };
  const result = await readRecord(folder, "result.json");
  if (result !== undefined) return replied(identity, result);
  if (parts.active.has(key)) return { kind: "accepted", ...identity };
  if ((await readRecord(folder, "started.json")) === undefined)
    return { kind: "absent" };
  const ending = interrupted("github-call-interrupted");
  await writeRecord(folder, { name: "result.json", value: ending });
  return replied(identity, ending);
}

async function outcome(
  parts: Parts,
  run: Started & { readonly signal: AbortSignal },
): Promise<Recorded> {
  const { intent, method, payload, signal } = run;
  const { settings } = parts;
  try {
    const result = await method({
      settings,
      calls: calls(settings, signal),
      target: intent.target,
      payload,
      signal,
    });
    return {
      outcome: "completed",
      result: JSON.stringify(result),
      endedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (signal.aborted)
      return { outcome: "stopped", endedAt: new Date().toISOString() };
    const reason = String(Reflect.get(Object(error), "message"));
    return interrupted(
      methodReasons.has(reason) ? reason : "github-call-failed",
    );
  }
}

function begun(parts: Parts, start: Started): void {
  const { key, folder, intent } = start;
  const stopping = new AbortController();
  const concluded = (async (): Promise<void> => {
    const recorded = await outcome(parts, {
      ...start,
      signal: stopping.signal,
    });
    await writeRecord(folder, { name: "result.json", value: recorded });
    await parts.settings.report(
      reportOf({ intent, commandId: `github:${key}`, worker }, recorded),
    );
  })()
    .catch(() => undefined)
    .finally(() => parts.active.delete(key));
  parts.active.set(key, { stopping, concluded });
}

function ownIntent(intent: DeliveryIntent): intent is ProtectedIntent {
  return (
    intent.capability === worker &&
    intent.method !== undefined &&
    intent.target !== undefined &&
    intent.payload !== undefined &&
    intent.leaseGeneration !== undefined
  );
}

function payloadOf(
  text: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...value }
      : undefined;
  } catch {
    return undefined;
  }
}

function failure(reason: string): AdapterOutcome {
  return { kind: "failed", reason };
}

async function delivered(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome | Identity> {
  if (!ownIntent(intent)) return failure("unsupported-effect");
  const method = methods.get(intent.method);
  if (method === undefined) return failure("unsupported-effect");
  const known = await reconciled(parts, intent);
  if (known.kind !== "absent") return known;
  const text = await parts.settings.document(intent.payload);
  if (text === undefined) return failure("payload-not-available");
  const payload = payloadOf(text);
  if (payload === undefined) return failure("invalid-payload");
  const place = placed(parts, intent);
  await writeRecord(place.folder, {
    name: "started.json",
    value: {
      operationId: intent.operationId,
      method: intent.method,
      target: intent.target,
      startedAt: new Date().toISOString(),
    },
  });
  begun(parts, { ...place, intent, method, payload });
  return { receipt: place.key, worker };
}

async function halted(active: Active): Promise<void> {
  active.stopping.abort();
  await active.concluded;
}

async function stopped(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const active = parts.active.get(placed(parts, intent).key);
  if (active !== undefined) await halted(active);
  return reconciled(parts, intent);
}

export function githubWorker(settings: GithubWorkerSettings): GithubWorker {
  if (settings.gh.length === 0) throw new Error("invalid-github-command");
  const parts: Parts = { settings, active: new Map() };
  return {
    deliver: (intent) => delivered(parts, intent),
    reconcile: (intent) => reconciled(parts, intent),
    stop: (intent) => stopped(parts, intent),
    close: async () => {
      await Promise.all([...parts.active.values()].map(halted));
    },
  };
}
