import { turnHarness, type HarnessSettings } from "../harness-defaults.ts";
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
import { type RunningTurn } from "./claude-turn.ts";
import { turnOutcome } from "./turn-report.ts";
import { startRetriedTurn, type RetrySettings } from "./retrying-turn.ts";
import {
  located,
  readRecord as read,
  replied,
  reportOf,
  writeRecord as written,
  type Located,
  type Recorded,
  type WorkerReport,
} from "./operation-journal.ts";
import {
  firstTurn,
  treeFailure,
  workTree,
  type WorkTree,
} from "./work-tree.ts";
import {
  recordedHarness,
  interruptedReply,
  processAlive,
  resumePlan,
  recordedField,
  type TurnResume,
  recoverTurn,
  turnIntent,
} from "./claude-recovery.ts";
import { selectedProfile } from "./worker-profile.ts";

export interface ClaudeWorkerSettings extends RetrySettings, HarnessSettings {
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
  readonly recover: (intent: DeliveryIntent) => Promise<void>;
  readonly harness: (operationId: string) => Promise<string | undefined>;
  readonly stop: NonNullable<Delivery["stop"]>;
  readonly close: () => Promise<void>;
}

export const claudeLimits = {
  summaryCharacters: 16_000,
  resultBytes: 48_000,
  stopMilliseconds: 15_000,
};

const worker = "claude";

interface Active {
  readonly worker: string;
  readonly turn: Promise<RunningTurn>;
  readonly concluded: Promise<void>;
  readonly stopping: {
    requested: boolean;
    stoppedBy?: "daemon-shutdown";
    readonly controller: AbortController;
  };
}

interface Parts {
  readonly reconciling: Map<string, Promise<AdapterOutcome>>;
  readonly settings: ClaudeWorkerSettings;
  readonly active: Map<string, Active>;
  readonly stopping: AbortController;
}

interface Started extends Located {
  readonly harness: ReturnType<typeof turnHarness>;
  readonly intent: ProtectedIntent;
  readonly tree: WorkTree;
}

function reconciled(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): Promise<AdapterOutcome> {
  const { intent } = call;
  const { key } = located(parts.settings.journal, intent.operationId);
  const pending = parts.reconciling.get(key);
  if (pending !== undefined) return pending;
  const reconciliation = reconcileOperation(parts, call).finally(() => {
    if (parts.reconciling.get(key) === reconciliation)
      parts.reconciling.delete(key);
  });
  parts.reconciling.set(key, reconciliation);
  return reconciliation;
}

async function reconcileOperation(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): Promise<AdapterOutcome> {
  const { intent, signal } = call;
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const result = await read(folder, "result.json");
  if (
    result !== undefined &&
    (recordedField(result, "stoppedBy") !== "daemon-shutdown" ||
      parts.stopping.signal.aborted)
  )
    return replied({ receipt: key, worker }, result);
  if (parts.active.has(key)) return { kind: "accepted", receipt: key, worker };
  const started = await read(folder, "started.json");
  if (started === undefined) return { kind: "absent" };
  if (processAlive(Reflect.get(Object(started), "processId")))
    return { kind: "unknown", evidence: `claude-turn:${key}` };
  return resumed(parts, { intent, key, folder, started, signal });
}

async function resumed(
  parts: Parts,
  request: Located & {
    readonly intent: DeliveryIntent;
    readonly started: unknown;
    readonly signal: AbortSignal;
  },
): Promise<AdapterOutcome> {
  const { intent, started, key, folder, signal } = request;
  const aborted = () => signal.aborted;
  const refused = () => interruptedReply(request, "claude-turn-interrupted");
  if (!turnIntent(intent)) return refused();
  if (aborted()) return failure("claude-start-aborted");
  const plan = await resumePlan(parts.settings, {
    folder,
    started,
    intent,
    signal,
  });
  if (aborted()) return failure("claude-start-aborted");
  if (typeof plan === "string") return interruptedReply(request, plan);
  await begun(parts, {
    key,
    folder,
    intent,
    ...plan,
    signal,
    prompt:
      "This turn stopped because the Cloving daemon restarted. Continue the task from the point where it stopped. Run again each command or subagent that did not end. End with the result line that the task asks for.",
  });
  return { kind: "accepted", receipt: key, worker };
}

async function concluded(
  parts: Parts,
  running: Started & {
    readonly turn: RunningTurn;
    readonly stopping: Active["stopping"];
  },
): Promise<void> {
  const { intent, key } = running;
  const recorded = await turnOutcome(
    { ...running, limits: claudeLimits },
    await running.turn.ended,
  );
  await written(running.folder, { name: "result.json", value: recorded });
  if (recorded.stoppedBy === "daemon-shutdown") return;
  await parts.settings.report(
    reportOf({ intent, commandId: `claude-turn:${key}`, worker }, recorded),
  );
}

async function begun(
  parts: Parts,
  start: Started & {
    readonly prompt: string;
    readonly profile: TurnProfile;
    readonly resume?: TurnResume;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const { intent, key, folder, tree, prompt } = start;
  const { harness } = start;
  const stopping = { requested: false, controller: new AbortController() };
  const cancel = () => {
    stopping.controller.abort();
  };
  start.signal.addEventListener("abort", cancel, { once: true });
  if (start.signal.aborted) cancel();
  const turn = startRetriedTurn(
    {
      ...harness,
      resultBytes: claudeLimits.resultBytes,
      command: profileCommand(harness.command, start.profile),
      environment: start.profile.env ?? {},
      turnId: `${intent.runId}-${key}`,
      directory: tree.path,
      folder,
      prompt,
    },
    {
      ...parts.settings,
      ...(start.resume === undefined ? {} : { resume: start.resume }),
      stopping: stopping.controller,
      metadata: {
        harness: harness.worker,
        operationId: intent.operationId,
        target: intent.target,
        branch: tree.branch,
        worktree: tree.path,
        startCommit: tree.startCommit,
      },
    },
  );
  parts.active.set(key, {
    worker: harness.worker,
    turn,
    stopping,
    concluded: turn
      .then((running) =>
        concluded(parts, { ...start, turn: running, stopping }),
      )
      .catch(() => undefined)
      .finally(() => parts.active.delete(key)),
  });
  await turn.finally(() => {
    start.signal.removeEventListener("abort", cancel);
  });
}

function failure(reason: string): AdapterOutcome {
  return { kind: "failed", reason };
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
  const known = await reconciled(parts, call);
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
  await begun(parts, {
    ...place,
    intent,
    tree: first,
    prompt,
    profile,
    harness: turnHarness(settings, profile),
    signal,
  });
  return { receipt: place.key, worker };
}

async function halted(parts: Parts, active: Active): Promise<void> {
  active.stopping.requested = true;
  active.stopping.controller.abort();
  const turn = await active.turn.catch(() => undefined);
  turn?.stop(parts.settings.stopMilliseconds ?? claudeLimits.stopMilliseconds);
  await active.concluded;
}

async function stopped(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const active = parts.active.get(key);
  if (active !== undefined) {
    delete active.stopping.stoppedBy;
    await halted(parts, active);
  }
  const result = await read(folder, "result.json");
  if (
    result !== undefined &&
    recordedField(result, "stoppedBy") !== "daemon-shutdown"
  )
    return replied({ receipt: key, worker }, result);
  const started = await read(folder, "started.json");
  if (started === undefined) return { kind: "absent" };
  if (recordedField(started, "harness") !== "claude")
    return reconcileOperation(parts, { intent, signal: parts.stopping.signal });
  if (processAlive(recordedField(started, "processId")))
    return { kind: "unknown", evidence: `claude-turn:${key}` };
  if (!turnIntent(intent)) return failure("unsupported-effect");
  const recorded: Recorded = {
    outcome: "stopped",
    endedAt: new Date().toISOString(),
  };
  await written(folder, { name: "result.json", value: recorded });
  await parts.settings.report(
    reportOf({ intent, commandId: `claude-turn:${key}`, worker }, recorded),
  );
  return replied({ receipt: key, worker }, recorded);
}

function stoppingOperation(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const { key } = located(parts.settings.journal, intent.operationId);
  const pending = parts.reconciling.get(key);
  const stop = () => stopped(parts, intent);
  const stopping = pending === undefined ? stop() : pending.then(stop, stop);
  const settled = stopping.finally(() => {
    if (parts.reconciling.get(key) === settled) parts.reconciling.delete(key);
  });
  parts.reconciling.set(key, settled);
  return settled;
}

export function claudeWorker(settings: ClaudeWorkerSettings): ClaudeWorker {
  if (settings.command.length === 0) throw new Error("invalid-claude-command");
  turnHarness(settings);
  for (const profile of Object.values(settings.profiles ?? {}))
    turnHarness(settings, profile);
  const parts: Parts = {
    settings,
    active: new Map(),
    reconciling: new Map(),
    stopping: new AbortController(),
  };
  const guarded = <T>(intent: DeliveryIntent, run: () => Promise<T>) =>
    intent.method === "run-turn:analyze-chats"
      ? Promise.resolve(failure("unsupported-effect"))
      : run();
  return {
    recover: (intent) =>
      turnIntent(intent)
        ? recoverTurn(
            { ...settings, intent, signal: parts.stopping.signal },
            () => reconciled(parts, { intent, signal: parts.stopping.signal }),
          )
        : Promise.resolve(),
    harness: (operationId) => recordedHarness(settings.journal, operationId),
    deliver: (intent, signal) =>
      guarded(intent, () =>
        delivered(parts, {
          intent,
          signal: AbortSignal.any([signal, parts.stopping.signal]),
        }),
      ),
    reconcile: (intent, signal) =>
      guarded(intent, () =>
        reconciled(parts, {
          intent,
          signal: AbortSignal.any([signal, parts.stopping.signal]),
        }),
      ),
    stop: (intent) => guarded(intent, () => stoppingOperation(parts, intent)),
    close: async () => {
      parts.stopping.abort();
      await Promise.all(
        [...parts.active.values()].map((active) => {
          if (active.worker === "claude" && !active.stopping.requested)
            active.stopping.stoppedBy = "daemon-shutdown";
          return halted(parts, active);
        }),
      );
    },
  };
}
