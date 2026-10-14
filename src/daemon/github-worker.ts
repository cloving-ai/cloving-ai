import { readdir } from "node:fs/promises";
import { join } from "node:path";
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
  type Reported,
  type WorkerReport,
} from "./operation-journal.ts";

export type { GithubTiming } from "./github-methods.ts";

export interface GithubWorkerSettings extends MethodSettings {
  readonly journal: string;
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly report: (report: WorkerReport) => Promise<unknown>;
  readonly operationStatus: (
    operationId: string,
  ) => Promise<string | undefined>;
  readonly runStatus: (runId: string) => Promise<string | undefined>;
}

export interface GithubWorker extends Delivery {
  readonly stop: NonNullable<Delivery["stop"]>;
  readonly scan: () => Promise<void>;
  readonly close: () => Promise<void>;
}

const worker = "github";
const closing = "github-worker-closed";
const endedRuns: ReadonlySet<string> = new Set([
  "cancelled",
  "failed",
  "completed",
]);
const unsettledOperations: ReadonlySet<string> = new Set([
  "dispatch-pending",
  "running",
  "recovering",
  "blocked",
]);
const outcomes = ["completed", "failed", "stopped"] as const;

interface Active {
  readonly stopping: AbortController;
  readonly concluded: Promise<void>;
}

interface Parts {
  readonly settings: GithubWorkerSettings;
  readonly active: Map<string, Active>;
  readonly scanned: PromiseWithResolvers<void>;
  readonly scans: Promise<void>[];
}

interface Kept extends Reported {
  readonly method: string;
  readonly target: string;
  readonly payloadText: string;
}

interface Started extends Located {
  readonly intent: Reported & { readonly target: string };
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

interface Ending {
  readonly start: Started;
  readonly recorded: Recorded;
}

async function reported(parts: Parts, ending: Ending): Promise<void> {
  const { start, recorded } = ending;
  const { key, intent } = start;
  await parts.settings.report(
    reportOf({ intent, commandId: `github:${key}`, worker }, recorded),
  );
}

async function ended(parts: Parts, ending: Ending): Promise<void> {
  const { start, recorded } = ending;
  await writeRecord(start.folder, { name: "result.json", value: recorded });
  await reported(parts, ending);
}

function begun(parts: Parts, start: Started): void {
  const { key } = start;
  const stopping = new AbortController();
  const concluded = (async (): Promise<void> => {
    const recorded = await outcome(parts, {
      ...start,
      signal: stopping.signal,
    });
    if (stopping.signal.reason === closing) return;
    await ended(parts, { start, recorded });
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
      runId: intent.runId,
      inputDigest: intent.inputDigest,
      leaseGeneration: intent.leaseGeneration,
      payloadText: text,
    },
  });
  begun(parts, { ...place, intent, method, payload });
  return { receipt: place.key, worker };
}

async function halted(active: Active, reason: string): Promise<void> {
  active.stopping.abort(reason);
  await active.concluded;
}

async function stopped(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const active = parts.active.get(placed(parts, intent).key);
  if (active !== undefined) await halted(active, "github-operation-stopped");
  return reconciled(parts, intent);
}

function textOf(value: unknown, name: string): string {
  const item: unknown = Reflect.get(Object(value), name);
  return typeof item === "string" ? item : "";
}

function keptOf(value: unknown): Kept | undefined {
  const leaseGeneration: unknown = Reflect.get(
    Object(value),
    "leaseGeneration",
  );
  const kept = {
    operationId: textOf(value, "operationId"),
    runId: textOf(value, "runId"),
    inputDigest: textOf(value, "inputDigest"),
    method: textOf(value, "method"),
    target: textOf(value, "target"),
    payloadText: textOf(value, "payloadText"),
  };
  if (typeof leaseGeneration !== "number" || Object.values(kept).includes(""))
    return undefined;
  return { ...kept, leaseGeneration };
}

function startOf(parts: Parts, value: unknown): Started | undefined {
  const kept = keptOf(value);
  if (kept === undefined) return undefined;
  const method = methods.get(kept.method);
  const payload = payloadOf(kept.payloadText);
  if (method === undefined || payload === undefined) return undefined;
  const place = located(parts.settings.journal, kept.operationId);
  return { ...place, intent: kept, method, payload };
}

function recordOf(value: unknown): Recorded | undefined {
  const outcome = outcomes.find((item) => item === textOf(value, "outcome"));
  if (outcome === undefined) return undefined;
  const result: unknown = Reflect.get(Object(value), "result");
  const reason: unknown = Reflect.get(Object(value), "reason");
  return {
    outcome,
    endedAt: textOf(value, "endedAt"),
    ...(typeof result === "string" ? { result } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

async function unsettled(parts: Parts, kept: Reported): Promise<boolean> {
  const status = await parts.settings.operationStatus(kept.operationId);
  return unsettledOperations.has(status ?? "");
}

async function live(parts: Parts, kept: Reported): Promise<boolean> {
  if (!(await unsettled(parts, kept))) return false;
  const run = await parts.settings.runStatus(kept.runId);
  return run !== undefined && !endedRuns.has(run);
}

async function resent(
  parts: Parts,
  saved: { readonly start: Started; readonly result: unknown },
): Promise<void> {
  const recorded = recordOf(saved.result);
  if (recorded === undefined) return;
  if (!(await unsettled(parts, saved.start.intent))) return;
  await reported(parts, { start: saved.start, recorded });
}

async function continued(parts: Parts, start: Started): Promise<void> {
  if (await live(parts, start.intent)) {
    begun(parts, start);
    return;
  }
  const recorded: Recorded = {
    outcome: "stopped",
    endedAt: new Date().toISOString(),
  };
  await ended(parts, { start, recorded });
}

async function resumed(parts: Parts, folder: string): Promise<void> {
  const started = await readRecord(folder, "started.json");
  if (started === undefined) return;
  const result = await readRecord(folder, "result.json");
  const start = startOf(parts, started);
  if (start !== undefined && result !== undefined) {
    await resent(parts, { start, result });
    return;
  }
  if (start !== undefined) {
    await continued(parts, start);
    return;
  }
  if (result !== undefined) return;
  const ending = interrupted("github-call-interrupted");
  await writeRecord(folder, { name: "result.json", value: ending });
}

async function scanned(parts: Parts): Promise<void> {
  const { journal } = parts.settings;
  const entries = await readdir(journal).catch(() => []);
  await Promise.all(
    entries.map((entry) =>
      resumed(parts, join(journal, entry)).catch(() => undefined),
    ),
  );
}

function scanning(parts: Parts): Promise<void> {
  const scan = scanned(parts).finally(() => {
    parts.scanned.resolve();
  });
  parts.scans.push(scan);
  return scan;
}

export function githubWorker(settings: GithubWorkerSettings): GithubWorker {
  if (settings.gh.length === 0) throw new Error("invalid-github-command");
  const parts: Parts = {
    settings,
    active: new Map(),
    scanned: Promise.withResolvers(),
    scans: [],
  };
  const after = <Value>(call: () => Promise<Value>): Promise<Value> =>
    parts.scanned.promise.then(call);
  return {
    deliver: (intent) => after(() => delivered(parts, intent)),
    reconcile: (intent) => after(() => reconciled(parts, intent)),
    stop: (intent) => after(() => stopped(parts, intent)),
    scan: () => scanning(parts),
    close: async () => {
      await Promise.all(parts.scans);
      await Promise.all(
        [...parts.active.values()].map((active) => halted(active, closing)),
      );
    },
  };
}
