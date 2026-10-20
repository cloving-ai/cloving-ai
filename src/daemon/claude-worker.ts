import { join } from "node:path";
import { ticketStatus } from "../ticket-status.ts";
import { sumPrices } from "../worker-usage.ts";
import { analysisWorker } from "./analysis-worker.ts";
import { analysisMethod } from "./analysis-launch.ts";
import {
  profileCommand,
  type TurnProfile,
  type TurnProfiles,
} from "../turn-profile.ts";
import type {
  AdapterOutcome,
  Delivery,
  DeliveryIntent,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";
import { type RunningTurn, type TurnEnd, type Worker } from "./claude-turn.ts";
import { startRetriedTurn, type RetrySettings } from "./retrying-turn.ts";
import {
  interrupted,
  located,
  operationKey,
  readRecord as read,
  replied,
  reportOf,
  writeRecord as written,
  type Located,
  type Recorded,
  type WorkerReport,
} from "./operation-journal.ts";
import { changes, treeFailure, workTree, type WorkTree } from "./work-tree.ts";

export interface ClaudeWorkerSettings extends RetrySettings {
  readonly worker?: Worker;
  readonly profiles?: TurnProfiles;
  readonly workflowId?: (runId: string) => Promise<string | undefined>;
  readonly repository: string;
  readonly worktrees: string;
  readonly journal: string;
  readonly command: readonly string[];
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly report: (report: WorkerReport) => Promise<unknown>;
  readonly stopMilliseconds?: number;
}

export interface ClaudeWorker extends Delivery {
  readonly stop: NonNullable<Delivery["stop"]>;
  readonly close: () => Promise<void>;
}

export const claudeLimits = {
  summaryCharacters: 16_000,
  resultBytes: 48_000,
  stopMilliseconds: 2_000,
};

const worker = "claude";

interface Active {
  readonly turn: Promise<RunningTurn>;
  readonly concluded: Promise<void>;
  readonly stopping: { requested: boolean };
}

interface Parts {
  readonly settings: ClaudeWorkerSettings;
  readonly active: Map<string, Active>;
  readonly stopping: AbortController;
}

interface Started extends Located {
  readonly intent: ProtectedIntent;
  readonly tree: WorkTree;
}

function alive(processId: unknown): boolean {
  if (typeof processId !== "number") return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
}

async function reconciled(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const result = await read(folder, "result.json");
  if (result !== undefined) return replied({ receipt: key, worker }, result);
  if (parts.active.has(key)) return { kind: "accepted", receipt: key, worker };
  const started = await read(folder, "started.json");
  if (started === undefined) return { kind: "absent" };
  if (alive(Reflect.get(Object(started), "processId")))
    return { kind: "unknown", evidence: `claude-turn:${key}` };
  const ending = interrupted("claude-turn-interrupted");
  await written(folder, { name: "result.json", value: ending });
  return replied({ receipt: key, worker }, ending);
}

async function resultText(
  tree: WorkTree,
  result: NonNullable<TurnEnd["result"]>,
): Promise<{ readonly text?: string; readonly reason?: string }> {
  const fields = {
    ticketStatus: ticketStatus(result.text),
    summary: result.text.slice(0, claudeLimits.summaryCharacters),
    ...(await changes(tree)),
    worktree: tree.path,
    costUsd: result.costUsd,
    usage: result.usage,
    model: result.model,
    ...(result.attempts === undefined ? {} : { attempts: result.attempts }),
    estimatedCostUsd: sumPrices(
      (result.attempts ?? []).map((attempt) => attempt.estimatedCostUsd),
    ),
    sessionId: result.sessionId,
    turns: result.turns,
  };
  const text = JSON.stringify(fields);
  const excess = Buffer.byteLength(text) - claudeLimits.resultBytes;
  if (excess <= 0) return { text };
  const kept = Math.max(0, fields.summary.length - excess);
  const shortened = JSON.stringify({
    ...fields,
    summary: fields.summary.slice(0, kept),
  });
  if (Buffer.byteLength(shortened) <= claudeLimits.resultBytes)
    return { text: shortened };
  const metadata = JSON.stringify({
    ...fields,
    ticketStatus: undefined,
    summary: "",
  });
  return {
    reason: "claude-result-too-large",
    ...(Buffer.byteLength(metadata) <= claudeLimits.resultBytes
      ? { text: metadata }
      : {}),
  };
}

async function outcome(
  running: Started & {
    readonly stopping: Active["stopping"];
  },
  end: TurnEnd,
): Promise<Recorded> {
  const endedAt = new Date().toISOString();
  const { result } = end;
  const report =
    result === undefined ? {} : await resultText(running.tree, result);
  const { text, reason } = report;
  if (
    reason === undefined &&
    text !== undefined &&
    end.exitCode === 0 &&
    result?.failed === false
  )
    return { outcome: "completed", result: text, endedAt };
  if (running.stopping.requested) return { outcome: "stopped", endedAt };
  return {
    outcome: "failed",
    reason: reason ?? "claude-turn-failed",
    ...(text === undefined ? {} : { result: text }),
    endedAt,
  };
}

async function concluded(
  parts: Parts,
  running: Started & {
    readonly turn: RunningTurn;
    readonly stopping: Active["stopping"];
  },
): Promise<void> {
  const { intent, key } = running;
  const recorded = await outcome(running, await running.turn.ended);
  await written(running.folder, { name: "result.json", value: recorded });
  await parts.settings.report(
    reportOf({ intent, commandId: `claude-turn:${key}`, worker }, recorded),
  );
}

async function begun(
  parts: Parts,
  start: Started & { readonly prompt: string; readonly profile: TurnProfile },
): Promise<void> {
  const { intent, key, folder, tree, prompt } = start;
  const turn = startRetriedTurn(
    {
      worker: parts.settings.worker ?? "claude",
      command: profileCommand(parts.settings.command, start.profile),
      environment: start.profile.env ?? {},
      turnId: `${intent.runId}-${key}`,
      directory: tree.path,
      folder,
      prompt,
    },
    {
      ...parts.settings,
      metadata: {
        operationId: intent.operationId,
        target: intent.target,
        branch: tree.branch,
        worktree: tree.path,
        startCommit: tree.startCommit,
      },
    },
  );
  const stopping = { requested: false };
  parts.active.set(key, {
    turn,
    stopping,
    concluded: turn
      .then((running) =>
        concluded(parts, { ...start, turn: running, stopping }),
      )
      .catch(() => undefined)
      .finally(() => parts.active.delete(key)),
  });
  await turn;
}

async function firstTurn(
  settings: ClaudeWorkerSettings,
  opening: { readonly tree: WorkTree; readonly intent: ProtectedIntent },
): Promise<WorkTree> {
  const { tree, intent } = opening;
  const { target, runId } = intent;
  const folder = target.startsWith("branch:")
    ? join(settings.journal, "runs", operationKey(runId), "targets")
    : join(settings.journal, "targets");
  const name = `${operationKey(target)}.json`;
  const startCommit: unknown = Reflect.get(
    Object(await read(folder, name)),
    "startCommit",
  );
  if (typeof startCommit === "string") return { ...tree, startCommit };
  await written(folder, {
    name,
    value: { target, startCommit: tree.startCommit },
  });
  return tree;
}

function turnIntent(intent: DeliveryIntent): intent is ProtectedIntent {
  return (
    intent.capability === worker &&
    (intent.method === "run-turn" ||
      /^run-turn:[A-Za-z0-9_-]{1,119}$/.test(intent.method ?? "")) &&
    intent.target !== undefined &&
    intent.payload !== undefined &&
    intent.leaseGeneration !== undefined
  );
}

function failure(reason: string): AdapterOutcome {
  return { kind: "failed", reason };
}

async function runWorkflow(
  settings: ClaudeWorkerSettings,
  runId: string,
): Promise<string | undefined> {
  try {
    return await settings.workflowId?.(runId);
  } catch {
    return undefined;
  }
}

async function selectedProfile(
  settings: ClaudeWorkerSettings,
  intent: ProtectedIntent,
): Promise<TurnProfile | string> {
  if (intent.method === "run-turn") return {};
  if (settings.worker === "codex") return "profile-needs-claude";
  const name = intent.method.slice("run-turn:".length);
  const profiles = settings.profiles ?? {};
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (profile === undefined) return "unknown-profile";
  if (profile.workflows === undefined) return profile;
  const workflowId = await runWorkflow(settings, intent.runId);
  if (workflowId === undefined || !profile.workflows.includes(workflowId))
    return "profile-not-allowed";
  return profile;
}

async function delivered(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): Promise<
  AdapterOutcome | { readonly receipt: string; readonly worker: string }
> {
  const { intent, signal } = call;
  const { settings } = parts;
  const aborted = (): boolean => signal.aborted;
  if (!turnIntent(intent)) return failure("unsupported-effect");
  if (aborted()) return failure("claude-start-aborted");
  const known = await reconciled(parts, intent);
  if (known.kind !== "absent") return known;
  const profile = await selectedProfile(settings, intent);
  if (typeof profile === "string") return failure(profile);
  const prompt = await settings.document(intent.payload);
  if (prompt === undefined) return failure("payload-not-available");
  const tree = await workTree({
    repository: settings.repository,
    worktrees: settings.worktrees,
    target: intent.target,
    signal,
  }).catch(treeFailure);
  if (aborted()) return failure("claude-start-aborted");
  if (typeof tree === "string") return failure(tree);
  const place = located(settings.journal, intent.operationId);
  const first = await firstTurn(settings, { tree, intent });
  if (aborted()) return failure("claude-start-aborted");
  await begun(parts, { ...place, intent, tree: first, prompt, profile });
  return { receipt: place.key, worker };
}

async function halted(parts: Parts, active: Active): Promise<void> {
  active.stopping.requested = true;
  const turn = await active.turn.catch(() => undefined);
  turn?.stop(parts.settings.stopMilliseconds ?? claudeLimits.stopMilliseconds);
  await active.concluded;
}

async function stopped(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const { key } = located(parts.settings.journal, intent.operationId);
  const active = parts.active.get(key);
  if (active !== undefined) await halted(parts, active);
  return reconciled(parts, intent);
}

export function claudeWorker(settings: ClaudeWorkerSettings): ClaudeWorker {
  if (settings.command.length === 0) throw new Error("invalid-claude-command");
  const parts: Parts = {
    settings,
    active: new Map(),
    stopping: new AbortController(),
  };
  const analysis = analysisWorker(settings);
  const guarded = async <T>(intent: DeliveryIntent, run: () => Promise<T>) => {
    if (
      !turnIntent(intent) ||
      Object.hasOwn(settings.profiles ?? {}, "analyze-chats") ||
      (await runWorkflow(settings, intent.runId)) !== "analyze-chats"
    )
      return failure("analysis-worker-unavailable");
    return run();
  };
  return {
    deliver: (intent, signal) =>
      intent.method === analysisMethod
        ? guarded(intent, () => analysis.deliver(intent, signal))
        : delivered(parts, {
            intent,
            signal: AbortSignal.any([signal, parts.stopping.signal]),
          }),
    reconcile: (intent, signal) =>
      intent.method === analysisMethod
        ? guarded(intent, () => analysis.reconcile(intent, signal))
        : reconciled(parts, intent),
    stop: (intent, signal) =>
      intent.method === analysisMethod
        ? guarded(intent, () => analysis.stop(intent, signal))
        : stopped(parts, intent),
    close: async () => {
      parts.stopping.abort();
      await analysis.close();
      await Promise.all(
        [...parts.active.values()].map((active) => halted(parts, active)),
      );
    },
  };
}
