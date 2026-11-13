import { WorkerReconciliation } from "./worker-reconciliation.ts";
import { consumePiShutdown, piResumeState } from "./pi-resume.ts";
import { turnHarness } from "../harness-defaults.ts";
import {
  piAttemptRefusal,
  piOperationRecord,
  piOperationRefusal,
} from "./pi-session.ts";
import type {
  AdapterOutcome,
  DeliveryIntent,
} from "../broker/actor/delivery-intents.ts";
import { begun } from "./claude-begin.ts";
import {
  attachPlan,
  holdKeptTurn,
  recordedTurnLaunch,
  recoverableTurn,
  rejectedAttach,
} from "./claude-attach.ts";
import type { TurnLaunch } from "../turn-launch.ts";
import {
  located,
  readRecord as read,
  replied,
  reportOf,
  writeRecord as written,
  type Located,
  type Recorded,
} from "./operation-journal.ts";
import { firstTurn, treeFailure, workTree } from "./work-tree.ts";
import {
  recordedHarness,
  interruptedReply,
  stopRecoveryPlan,
  uncertainProcess,
  resumePlan,
  recordedField,
  recoverTurn,
  turnIntent,
} from "./claude-recovery.ts";
import { checkedProfiles, selectedProfile } from "./worker-profile.ts";
import { noteDesk } from "./turn-notes.ts";
import {
  queued,
  type SteerAnswer,
  type SteerRequest,
} from "./turn-steering.ts";
import {
  claudeLimits,
  resumableActive,
  nativePiOperation,
  type Active,
  type ClaudeWorkerSettings,
  type Parts,
  type ClaudeWorker,
} from "./claude-worker-parts.ts";

export {
  type ClaudeWorker,
  claudeLimits,
  type ClaudeWorkerSettings,
  type CloseOptions,
} from "./claude-worker-parts.ts";

const worker = "claude";

async function reconciled(
  parts: Parts,
  call: { readonly intent: DeliveryIntent; readonly signal: AbortSignal },
): Promise<AdapterOutcome> {
  const { intent } = call;
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const started = await piOperationRecord(folder, parts.active.get(key));
  const conflict = piOperationRefusal(started, { intent, key });
  if (conflict !== undefined) return conflict;
  return parts.reconciling.run(key, {
    signal: call.signal,
    perform: (signal) => reconcileOperation(parts, { intent, signal }),
  });
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
  const conflict = await piAttemptRefusal(folder, started);
  if (conflict !== undefined)
    return { kind: "unknown", evidence: `${conflict}:${key}` };
  if ((await read(folder, "stop-request.json")) !== undefined)
    return stopped(parts, intent);
  const resumeState = piResumeState(started, result);
  if (resumeState === "resume")
    return resumed(parts, { intent, key, folder, started, signal });
  const launch = await recordedTurnLaunch(parts.settings, {
    folder,
    started,
    result: resumeState === "attach" ? undefined : result,
  });
  return launchedOrResumed(parts, {
    intent,
    key,
    folder,
    started,
    signal,
    launch,
  });
}

async function launchedOrResumed(
  parts: Parts,
  request: Located & {
    readonly intent: DeliveryIntent;
    readonly started: unknown;
    readonly signal: AbortSignal;
    readonly launch: TurnLaunch | "gone" | "stopped" | "unknown" | undefined;
  },
): Promise<AdapterOutcome> {
  const { launch, ...rest } = request;
  if (launch === "stopped")
    return interruptedReply(rest, "claude-turn-interrupted");
  if (
    (launch === "gone" || launch === undefined) &&
    recordedField(rest.started, "harness") === "pi"
  )
    return {
      kind: "unknown",
      evidence: `pi-prior-result-uncertain:${rest.key}`,
    };
  if (
    launch === "unknown" ||
    (launch === undefined && (await uncertainProcess(rest.started)))
  )
    return { kind: "unknown", evidence: `claude-turn:${rest.key}` };
  return resumed(parts, {
    ...rest,
    ...(launch === undefined || launch === "gone" ? {} : { launch }),
  });
}

async function resumed(
  parts: Parts,
  request: Located & {
    readonly intent: DeliveryIntent;
    readonly started: unknown;
    readonly signal: AbortSignal;
    readonly launch?: TurnLaunch;
  },
): Promise<AdapterOutcome> {
  const { intent, started, key, folder, signal, launch } = request;
  const aborted = () => signal.aborted;
  if (!turnIntent(intent))
    return interruptedReply(request, "claude-turn-interrupted");
  if (aborted()) return failure("claude-start-aborted");
  const current = parts.settings.turnSettings();
  const settings = { ...parts.settings, ...current };
  const plan = await (launch === undefined
    ? resumePlan(settings, { folder, started, intent, signal })
    : attachPlan(settings, { folder, started, intent, launch }));
  if (aborted()) return failure("claude-start-aborted");
  if (typeof plan === "string")
    return rejectedAttach({
      request,
      plan,
      launch,
      stopMilliseconds: parts.settings.stopMilliseconds,
    });
  const prompt = await parts.settings.document(intent.payload);
  if (aborted()) return failure("claude-start-aborted");
  if (prompt === undefined)
    return interruptedReply(request, "claude-turn-interrupted");
  parts.settings.recovered?.({
    runId: intent.runId,
    way: launch === undefined ? "resumed" : "connected",
  });
  const noted = await parts.notes.recorded({ ...intent, prompt, started });
  await consumePiShutdown(folder, plan);
  await begun(parts, {
    key,
    folder,
    intent,
    ...plan,
    signal,
    ...noted,
    turnSettings: current,
  });
  return { kind: "accepted", receipt: key, worker };
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
  const current = settings.turnSettings();
  const profile = await selectedProfile({ ...settings, ...current }, intent);
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
  const noted = await parts.notes.claim({ ...intent, prompt });
  await begun(parts, {
    ...place,
    intent,
    tree: first,
    ...noted,
    profile,
    harness: turnHarness(settings, profile),
    signal,
    turnSettings: current,
  }).finally(() => parts.notes.settle({ ...noted, folder: place.folder }));
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
  const ownership = await piOperationRecord(folder, parts.active.get(key));
  const conflict = piOperationRefusal(ownership, { intent, key });
  if (conflict !== undefined) return conflict;
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
  const plan = stopRecoveryPlan({ started, key });
  if (plan === "reconcile")
    return reconcileOperation(parts, { intent, signal: parts.stopping.signal });
  if (plan !== undefined) return plan;
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

async function steered(
  parts: Parts,
  request: SteerRequest,
): Promise<SteerAnswer> {
  const active = [...parts.active.values()].find(
    (candidate) => candidate.intent.runId === request.runId,
  );
  if (active === undefined) return queued("no-open-turn");
  const turn = await active.turn;
  const outcome = turn.steer(request);
  if (outcome.delivery === "queued") return outcome;
  return { delivery: "now", operationId: active.intent.operationId };
}

async function stoppingOperation(
  parts: Parts,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const { key, folder } = located(parts.settings.journal, intent.operationId);
  const started = await piOperationRecord(folder, parts.active.get(key));
  const conflict = piOperationRefusal(started, { intent, key });
  if (conflict !== undefined) return conflict;
  const nativePi = nativePiOperation(started, parts.active.get(key));
  return parts.reconciling.stop(key, {
    cancelPending:
      nativePi &&
      piResumeState(started, await read(folder, "result.json")) === "resume",
    ...(nativePi
      ? {
          record: () =>
            written(folder, {
              name: "stop-request.json",
              value: { operationId: intent.operationId, target: intent.target },
              permissions: "private",
            }),
        }
      : {}),
    perform: () => stopped(parts, intent),
  });
}

export function claudeWorker(settings: ClaudeWorkerSettings): ClaudeWorker {
  if (settings.command.length === 0) throw new Error("invalid-claude-command");
  turnHarness(settings);
  checkedProfiles(settings, settings.turnSettings().profiles);
  const parts: Parts = {
    settings,
    active: new Map(),
    reconciling: new WorkerReconciliation(),
    stopping: new AbortController(),
    release: new AbortController(),
    notes: noteDesk(settings),
  };
  const guarded = <T>(intent: DeliveryIntent, run: () => Promise<T>) =>
    intent.method === "run-turn:analyze-chats"
      ? Promise.resolve(failure("unsupported-effect"))
      : run();
  return {
    hold: (intent) => holdKeptTurn(settings.journal, intent),
    recover: async (intent) => {
      if (!turnIntent(intent)) return;
      if (!(await recoverableTurn(settings.journal, intent))) return;
      await recoverTurn(
        { ...settings, intent, signal: parts.stopping.signal },
        () => reconciled(parts, { intent, signal: parts.stopping.signal }),
      );
    },
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
    steer: (request) => steered(parts, request),
    close: async (options = {}) => {
      if (options.turns === "keep") parts.release.abort();
      parts.stopping.abort();
      await Promise.all(
        [...parts.active.values()].map((active) => {
          if (resumableActive(active) && !active.stopping.requested)
            active.stopping.stoppedBy = "daemon-shutdown";
          return halted(parts, active);
        }),
      );
    },
  };
}
